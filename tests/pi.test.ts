import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type AgentSession,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { APPROVED_TOOLS, type MarvinConfig } from "../src/config.ts";
import { Marvin } from "../src/marvin.ts";
import { PiAssistant, type AssistantOutcome } from "../src/pi.ts";

const roots: string[] = [];
const sessions = new Set<AgentSession>();

afterEach(async () => {
  for (const session of sessions) {
    session.dispose();
  }
  sessions.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function emptyResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are Marvin. Be concise.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
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

async function createHarness(tools: string[] = [...APPROVED_TOOLS]) {
  const root = await mkdtemp(join(tmpdir(), "marvin-pi-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessionDir, { mode: 0o700 })]);

  const faux = fauxProvider({ provider: `marvin-test-${crypto.randomUUID()}` });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });

  const { session } = await createAgentSession({
    cwd: workspace,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: emptyResourceLoader(),
    sessionManager: SessionManager.continueRecent(workspace, sessionDir),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }),
    tools,
  });
  sessions.add(session);
  const config: MarvinConfig = { discordToken: "test", workspace, sessionDir };

  const createAssistant = async () => {
    const assistant = await PiAssistant.create(config, {
      createSession: async (receivedConfig) => {
        expect(receivedConfig).toBe(config);
        return session;
      },
    });
    return assistant;
  };

  return { createAssistant, faux, session };
}

function nextOutcome(assistant: PiAssistant): Promise<AssistantOutcome> {
  return new Promise((resolve) => {
    assistant.setOutcomeHandler(resolve);
  });
}

describe("PiAssistant", () => {
  test("admits a prompt and publishes its terminal answer", async () => {
    const { createAssistant, faux } = await createHarness();
    const assistant = await createAssistant();
    faux.setResponses([fauxAssistantMessage("Hello from Marvin.")]);
    const outcome = nextOutcome(assistant);

    expect(await assistant.admit("hello")).toEqual({ kind: "started" });
    expect(await outcome).toEqual({ type: "answer", text: "Hello from Marvin." });
  });

  test("returns busy without forwarding a second prompt", async () => {
    const { createAssistant, faux, session } = await createHarness();
    const assistant = await createAssistant();
    const response = deferred<AssistantMessage>();
    const forwarded = deferred<void>();
    faux.setResponses([
      () => {
        forwarded.resolve();
        return response.promise;
      },
    ]);
    const outcome = nextOutcome(assistant);

    expect(await assistant.admit("first prompt")).toEqual({ kind: "started" });
    await forwarded.promise;
    expect(await assistant.admit("second prompt")).toEqual({ kind: "busy" });
    expect(faux.state.callCount).toBe(1);
    expect(JSON.stringify(session.messages)).not.toContain("second prompt");

    response.resolve(fauxAssistantMessage("first answer"));
    expect(await outcome).toEqual({ type: "answer", text: "first answer" });
  });

  test("rejects a concurrent prompt without ordering its response", async () => {
    const { createAssistant, faux, session } = await createHarness();
    const assistant = await createAssistant();
    const response = deferred<AssistantMessage>();
    faux.setResponses([() => response.promise]);
    const sent: string[] = [];
    const marvin = new Marvin(
      assistant,
      async (text) => void sent.push(text),
      () => {},
    );
    assistant.setOutcomeHandler(marvin.handleOutcome.bind(marvin));

    await Promise.all([
      marvin.handle({ type: "prompt", text: "first" }),
      marvin.handle({ type: "prompt", text: "second" }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent).toContain("Marvin is already working; try again after it finishes.");

    response.resolve(fauxAssistantMessage("first answer"));
    await session.waitForIdle();
    expect(sent).toHaveLength(2);
    expect(sent).toContain("first answer");
  });

  test("publishes a request failure when the provider fails", async () => {
    const { createAssistant, faux } = await createHarness();
    const assistant = await createAssistant();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
    ]);
    const outcome = nextOutcome(assistant);

    expect(await assistant.admit("fail")).toEqual({ kind: "started" });
    expect(await outcome).toEqual({ type: "failure", reason: "request_failed" });
  });

  test("rejects a session with tools outside the approved set", async () => {
    const { createAssistant } = await createHarness([...APPROVED_TOOLS, "edit"]);

    await expect(createAssistant()).rejects.toMatchObject({
      name: "PiStartupError",
      reason: "runtime_failed",
    });
  });
});
