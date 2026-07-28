import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function emptyResourceLoader(systemPrompt = "You are Marvin. Be concise."): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function createHarness(options: {
  faux?: RegisterFauxProviderOptions;
  retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "marvin-pi-contract-"));
  roots.push(root);

  const workspace = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessionDir, { mode: 0o700 })]);

  const faux = fauxProvider({ ...options.faux, provider: `marvin-test-${crypto.randomUUID()}` });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });

  const sessionManager = SessionManager.continueRecent(workspace, sessionDir);
  const { session, extensionsResult } = await createAgentSession({
    cwd: workspace,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: emptyResourceLoader(),
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      retry: options.retry ?? { enabled: false },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }),
    tools: ["read", "bash", "grep", "find", "ls"],
  });

  return { extensionsResult, faux, modelRuntime, session, sessionDir, sessionManager, workspace };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function acceptedPrompt(session: AgentSession, text: string) {
  const accepted = deferred<boolean>();
  const completion = session.prompt(text, {
    expandPromptTemplates: false,
    source: "rpc",
    preflightResult: accepted.resolve,
  });
  return { accepted: await accepted.promise, completion };
}

describe("pinned Pi SDK contract", () => {
  test("constructs with only approved tools and no discovered resources", async () => {
    const { extensionsResult, modelRuntime, session } = await createHarness();

    try {
      expect(session.getActiveToolNames().sort()).toEqual(["bash", "find", "grep", "ls", "read"]);
      expect(extensionsResult.extensions).toEqual([]);
      expect(extensionsResult.errors).toEqual([]);
      expect(session.promptTemplates).toEqual([]);
      expect(session.resourceLoader.getSkills().skills).toEqual([]);
      expect(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(await modelRuntime.getAuth(session.model!)).toBeDefined();
    } finally {
      session.dispose();
    }
  });

  test("exposes prompt acceptance before completion and persists the terminal answer", async () => {
    const { faux, session, sessionDir, sessionManager, workspace } = await createHarness();
    const response = deferred<AssistantMessage>();
    const events: AgentSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    faux.setResponses([() => response.promise]);

    try {
      const prompt = await acceptedPrompt(session, "hello");
      expect(prompt.accepted).toBe(true);
      expect(session.isStreaming).toBe(true);

      response.resolve(fauxAssistantMessage("Hello from Marvin."));
      await prompt.completion;

      expect(session.isStreaming).toBe(false);
      expect(events.some((event) => event.type === "agent_settled")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.content.some(
              (block) => block.type === "text" && block.text === "Hello from Marvin.",
            ),
        ),
      ).toBe(true);
      expect(sessionManager.isPersisted()).toBe(true);

      const resumed = SessionManager.continueRecent(workspace, sessionDir);
      expect(resumed.getSessionId()).toBe(sessionManager.getSessionId());
      expect(resumed.getEntries().some((entry) => entry.type === "message")).toBe(true);
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  test("resumes the admission continuation before a terminal answer event", async () => {
    const { faux, session } = await createHarness();
    const accepted = deferred<boolean>();
    const order: string[] = [];
    faux.setResponses([fauxAssistantMessage("Immediate answer.")]);
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "stop"
      ) {
        order.push("answer");
      }
    });

    try {
      const completion = session.prompt("answer immediately", {
        expandPromptTemplates: false,
        source: "rpc",
        preflightResult: (success) => {
          order.push("preflight");
          accepted.resolve(success);
        },
      });
      expect(await accepted.promise).toBe(true);
      order.push("admission");
      await completion;

      expect(order).toEqual(["preflight", "admission", "answer"]);
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  test("reports preflight rejection without retaining rejected prompt text", async () => {
    const { session, sessionManager } = await createHarness();
    (session.agent.state as { model: unknown }).model = undefined;
    const accepted = deferred<boolean>();

    try {
      await expect(
        session.prompt("must-not-be-retained", {
          expandPromptTemplates: false,
          source: "rpc",
          preflightResult: accepted.resolve,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await accepted.promise).toBe(false);
      expect(JSON.stringify(session.messages)).not.toContain("must-not-be-retained");
      expect(JSON.stringify(sessionManager.getEntries())).not.toContain("must-not-be-retained");
    } finally {
      session.dispose();
    }
  });

  test("continues after a length response containing a truncated tool call", async () => {
    const { faux, session } = await createHarness();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }), {
        stopReason: "length",
      }),
      fauxAssistantMessage("Recovered after the truncated tool call."),
    ]);
    const events: AgentSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    try {
      const prompt = await acceptedPrompt(session, "Read package.json");
      expect(prompt.accepted).toBe(true);
      await prompt.completion;

      expect(faux.state.callCount).toBe(2);
      expect(
        events.some(
          (event) =>
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.stopReason === "length" &&
            event.message.content.some((block) => block.type === "toolCall"),
        ),
      ).toBe(true);
      expect(session.getLastAssistantText()).toBe("Recovered after the truncated tool call.");
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  test("retries a retryable provider failure before settling with an answer", async () => {
    const { faux, session } = await createHarness({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 unavailable" }),
      fauxAssistantMessage("Retry succeeded."),
    ]);
    const eventTypes: string[] = [];
    const unsubscribe = session.subscribe((event) => eventTypes.push(event.type));

    try {
      const prompt = await acceptedPrompt(session, "retry this");
      expect(prompt.accepted).toBe(true);
      await prompt.completion;

      expect(faux.state.callCount).toBe(2);
      expect(eventTypes).toContain("auto_retry_start");
      expect(eventTypes).toContain("auto_retry_end");
      expect(eventTypes.at(-1)).toBe("agent_settled");
      expect(session.getLastAssistantText()).toBe("Retry succeeded.");
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

});
