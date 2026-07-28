import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { APPROVED_TOOLS, type MarvinConfig } from "./config.ts";

const SYSTEM_PROMPT = `You are Marvin, a personal AI assistant.
Use the approved tools when they are useful for the user's request.`;

const THINKING_LEVELS = new Set<NonNullable<CreateAgentSessionOptions["thinkingLevel"]>>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type Admission =
  | { kind: "started" }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "failed"; fatal: boolean };

export type AssistantOutcome =
  | { type: "answer"; text: string }
  | { type: "failure"; reason: "request_failed" }
  | { type: "fatal"; reason: "runtime_failed" };

export type PiStartupFailureReason =
  | "model_unavailable"
  | "authentication_unavailable"
  | "runtime_failed";

export class PiStartupError extends Error {
  constructor(readonly reason: PiStartupFailureReason) {
    super(reason);
    this.name = "PiStartupError";
  }
}

interface ActiveRun {
  accepted: boolean;
  outcomePublished: boolean;
}

export interface PiAssistantCreateOptions {
  /** Internal test seam. Production callers leave this unset. */
  createSession?: (config: MarvinConfig) => Promise<AgentSession>;
}

function emptyResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function parseConfiguredModel(selector: string): {
  provider: string;
  modelId: string;
  thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
} {
  const separator = selector.indexOf("/");
  if (separator <= 0 || separator === selector.length - 1) {
    throw new PiStartupError("model_unavailable");
  }

  const provider = selector.slice(0, separator);
  let modelId = selector.slice(separator + 1);
  let thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]> | undefined;
  const thinkingSeparator = modelId.lastIndexOf(":");
  if (thinkingSeparator > 0) {
    const candidate = modelId.slice(thinkingSeparator + 1) as NonNullable<
      CreateAgentSessionOptions["thinkingLevel"]
    >;
    if (THINKING_LEVELS.has(candidate)) {
      thinkingLevel = candidate;
      modelId = modelId.slice(0, thinkingSeparator);
    }
  }

  if (!modelId) {
    throw new PiStartupError("model_unavailable");
  }
  return { provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

async function createProductionSession(config: MarvinConfig): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const sourceSettings = SettingsManager.create(config.workspace, agentDir, { projectTrusted: false });
  if (sourceSettings.drainErrors().length > 0) {
    throw new PiStartupError("runtime_failed");
  }

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: sourceSettings.getDefaultProvider(),
    defaultModel: sourceSettings.getDefaultModel(),
    defaultThinkingLevel: sourceSettings.getDefaultThinkingLevel(),
    compaction: sourceSettings.getCompactionSettings(),
    branchSummary: sourceSettings.getBranchSummarySettings(),
    retry: {
      ...sourceSettings.getRetrySettings(),
      provider: sourceSettings.getProviderRetrySettings(),
    },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    images: { blockImages: true },
  });
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });

  let model: CreateAgentSessionOptions["model"];
  let thinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
  if (config.model) {
    const configured = parseConfiguredModel(config.model);
    model = modelRuntime.getModel(configured.provider, configured.modelId);
    thinkingLevel = configured.thinkingLevel;
    if (!model) {
      throw new PiStartupError("model_unavailable");
    }
    if (!(await modelRuntime.getAuth(model))) {
      throw new PiStartupError("authentication_unavailable");
    }
  }

  const { session, extensionsResult } = await createAgentSession({
    cwd: config.workspace,
    agentDir,
    model,
    thinkingLevel,
    modelRuntime,
    resourceLoader: emptyResourceLoader(),
    sessionManager: SessionManager.continueRecent(config.workspace, config.sessionDir),
    settingsManager,
    tools: [...APPROVED_TOOLS],
  });

  if (extensionsResult.errors.length > 0) {
    session.dispose();
    throw new PiStartupError("runtime_failed");
  }
  return session;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class PiAssistant {
  private outcomeHandler?: (outcome: AssistantOutcome) => void;
  private activeRun?: ActiveRun;
  private permanentlyClosed = false;

  private constructor(private readonly session: AgentSession) {
    session.subscribe((event) => {
      try {
        this.handleSessionEvent(event);
      } catch {
        this.handleFatalRuntimeFailure();
      }
    });
  }

  static defaultSessionDir(): string {
    return join(getAgentDir(), "marvin", "sessions");
  }

  static async create(
    config: MarvinConfig,
    options: PiAssistantCreateOptions = {},
  ): Promise<PiAssistant> {
    let session: AgentSession | undefined;
    try {
      session = await (options.createSession ?? createProductionSession)(config);
      if (!session.model) {
        throw new PiStartupError("model_unavailable");
      }
      try {
        if (!(await session.modelRuntime.getAuth(session.model))) {
          throw new PiStartupError("authentication_unavailable");
        }
      } catch (error) {
        if (error instanceof PiStartupError) {
          throw error;
        }
        throw new PiStartupError("authentication_unavailable");
      }

      const actualTools = session.getActiveToolNames().sort();
      const expectedTools = [...APPROVED_TOOLS].sort();
      if (!sameValues(actualTools, expectedTools)) {
        throw new PiStartupError("runtime_failed");
      }
      const resources = session.resourceLoader;
      const extensions = resources.getExtensions();
      if (
        session.promptTemplates.length > 0 ||
        extensions.extensions.length > 0 ||
        extensions.errors.length > 0 ||
        resources.getSkills().skills.length > 0 ||
        resources.getPrompts().prompts.length > 0 ||
        resources.getThemes().themes.length > 0 ||
        resources.getAgentsFiles().agentsFiles.length > 0 ||
        resources.getAppendSystemPrompt().length > 0
      ) {
        throw new PiStartupError("runtime_failed");
      }

      return new PiAssistant(session);
    } catch (error) {
      session?.dispose();
      if (error instanceof PiStartupError) {
        throw error;
      }
      throw new PiStartupError("runtime_failed");
    }
  }

  setOutcomeHandler(handler: (outcome: AssistantOutcome) => void): void {
    this.outcomeHandler = handler;
  }

  async admit(text: string): Promise<Admission> {
    if (this.permanentlyClosed) {
      return { kind: "unavailable" };
    }
    if (this.activeRun || this.session.isStreaming) {
      return { kind: "busy" };
    }

    let resolvePreflight!: (accepted: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    const run: ActiveRun = {
      accepted: false,
      outcomePublished: false,
    };
    this.activeRun = run;

    try {
      void this.session
        .prompt(text, {
          expandPromptTemplates: false,
          source: "rpc",
          preflightResult: resolvePreflight,
        })
        .catch(() => {
          resolvePreflight(false);
          if (run.accepted && this.activeRun === run && this.session.isIdle) {
            this.publishFailure(run);
            this.activeRun = undefined;
          }
        });

      const accepted = await preflight;
      if (!accepted) {
        this.activeRun = undefined;
        return { kind: "failed", fatal: false };
      }

      run.accepted = true;
      return { kind: "started" };
    } catch {
      this.activeRun = undefined;
      return { kind: "failed", fatal: false };
    }
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_settled") {
      const run = this.activeRun;
      if (run && run.accepted && !run.outcomePublished && !this.permanentlyClosed) {
        this.publishFailure(run);
      }
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") {
      return;
    }

    const run = this.activeRun;
    if (!run || run.outcomePublished || this.permanentlyClosed) {
      return;
    }
    if (event.message.content.some((block) => block.type === "toolCall")) {
      return;
    }
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      return;
    }

    const text = event.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    run.outcomePublished = true;
    this.dispatch({ type: "answer", text });
  }

  private publishFailure(run: ActiveRun): void {
    if (run.outcomePublished || this.permanentlyClosed) {
      return;
    }
    run.outcomePublished = true;
    this.dispatch({ type: "failure", reason: "request_failed" });
  }

  private handleFatalRuntimeFailure(): void {
    if (this.permanentlyClosed) {
      return;
    }
    this.permanentlyClosed = true;
    this.dispatch({ type: "fatal", reason: "runtime_failed" });
  }

  private dispatch(outcome: AssistantOutcome): void {
    try {
      this.outcomeHandler?.(outcome);
    } catch {
      // Handler failures must not break the Pi event pipeline.
    }
  }
}
