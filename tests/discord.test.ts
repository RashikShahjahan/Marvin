import { describe, expect, test } from "bun:test";
import {
  ChannelType,
  GatewayIntentBits,
  Partials,
  type Client,
  type ClientOptions,
  type Message,
} from "discord.js";
import {
  DiscordStartupError,
  DiscordTransport,
  type DiscordIngress,
  type IngressHandler,
} from "../src/discord.ts";

interface SendPayload {
  content: string;
  allowedMentions: { parse: string[]; repliedUser: boolean };
}

class FakeChannel {
  readonly sent: SendPayload[] = [];
  readonly type: ChannelType;
  sendHook?: (payload: SendPayload, index: number) => Promise<void>;

  constructor(type: ChannelType = ChannelType.DM) {
    this.type = type;
  }

  send(payload: SendPayload): Promise<void> {
    const index = this.sent.push(payload) - 1;
    return this.sendHook?.(payload, index) ?? Promise.resolve();
  }
}

type Listener = (...args: unknown[]) => void;

class FakeClient {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly loginTokens: string[] = [];
  destroyCalls = 0;
  loginError?: unknown;

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  async login(token: string): Promise<string> {
    this.loginTokens.push(token);
    if (this.loginError) {
      throw this.loginError;
    }
    return token;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  destroy(): void {
    this.destroyCalls += 1;
  }
}

function fakeMessage(options: {
  bot?: boolean;
  channel?: FakeChannel;
  content?: string;
  attachments?: number;
} = {}): Message {
  return {
    author: { bot: options.bot ?? false },
    channel: options.channel ?? new FakeChannel(),
    content: options.content ?? "hello",
    attachments: { size: options.attachments ?? 0 },
  } as unknown as Message;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function createHarness(options: {
  ingress?: IngressHandler;
  onFatal?: () => void;
} = {}) {
  const client = new FakeClient();
  const ingress: DiscordIngress[] = [];
  const fatals: true[] = [];
  let clientOptions: ClientOptions | undefined;
  const transport = new DiscordTransport((receivedOptions) => {
    clientOptions = receivedOptions;
    return client as unknown as Client;
  });
  await transport.start(
    "discord-token",
    options.ingress ??
      (async (event) => {
        ingress.push(event);
      }),
    () => {
      fatals.push(true);
      options.onFatal?.();
    },
  );

  return { client, clientOptions, fatals, ingress, transport };
}

describe("DiscordTransport ingress", () => {
  test("starts with only direct-message requirements", async () => {
    const harness = await createHarness();

    expect(harness.client.loginTokens).toEqual(["discord-token"]);
    expect(harness.clientOptions?.intents).toEqual([GatewayIntentBits.DirectMessages]);
    expect(harness.clientOptions?.partials).toEqual([Partials.Channel]);
  });

  test("filters bots, non-DMs, and empty DMs while preserving original prompt content", async () => {
    const harness = await createHarness();
    harness.client.emit("messageCreate", fakeMessage({ bot: true, content: "from bot" }));
    harness.client.emit(
      "messageCreate",
      fakeMessage({ channel: new FakeChannel(ChannelType.GuildText), content: "from guild" }),
    );
    harness.client.emit("messageCreate", fakeMessage({ content: " \n\t " }));
    harness.client.emit(
      "messageCreate",
      fakeMessage({ content: " \n\t ", attachments: 1 }),
    );
    harness.client.emit(
      "messageCreate",
      fakeMessage({ content: "  keep <@123> unchanged  ", attachments: 1 }),
    );

    expect(harness.ingress).toEqual([
      { type: "attachment_only" },
      { type: "prompt", text: "  keep <@123> unchanged  " },
    ]);
  });

  test("catches rejected ingress handlers", async () => {
    const harness = await createHarness({
      ingress: async () => {
        throw new Error("ingress failure");
      },
    });

    expect(() => harness.client.emit("messageCreate", fakeMessage())).not.toThrow();
    await flushMicrotasks();
  });

  test("catches synchronously throwing ingress handlers", async () => {
    const harness = await createHarness({
      ingress: () => {
        throw new Error("synchronous ingress failure");
      },
    });

    expect(() => harness.client.emit("messageCreate", fakeMessage())).not.toThrow();
    await flushMicrotasks();
  });
});

describe("DiscordTransport output", () => {
  test("sends responses immediately and disables mentions", async () => {
    const harness = await createHarness();
    const channel = new FakeChannel();
    const firstSend = deferred();
    let activeSends = 0;
    let maximumActiveSends = 0;
    channel.sendHook = async (_payload, index) => {
      activeSends += 1;
      maximumActiveSends = Math.max(maximumActiveSends, activeSends);
      if (index === 0) {
        await firstSend.promise;
      }
      activeSends -= 1;
    };
    harness.client.emit("messageCreate", fakeMessage({ channel, content: "set destination" }));

    const longMessage = "a".repeat(2_001);
    const first = harness.transport.send(longMessage);
    const second = harness.transport.send("@everyone <@123>");

    expect(channel.sent.map(({ content }) => content)).toEqual([
      "a".repeat(2_000),
      "@everyone <@123>",
    ]);
    firstSend.resolve();
    await Promise.all([first, second]);

    expect(channel.sent.map(({ content }) => content)).toEqual([
      "a".repeat(2_000),
      "@everyone <@123>",
      "a",
    ]);
    expect(maximumActiveSends).toBe(2);
    expect(channel.sent.every(({ allowedMentions }) =>
      JSON.stringify(allowedMentions) === JSON.stringify({ parse: [], repliedUser: false }),
    )).toBe(true);
  });

  test("one failed send does not affect another send", async () => {
    const harness = await createHarness();
    const channel = new FakeChannel();
    channel.sendHook = async (_payload, index) => {
      if (index === 0) {
        throw new Error("Discord rejected the first send");
      }
    };
    harness.client.emit("messageCreate", fakeMessage({ channel, content: "set destination" }));

    const failed = harness.transport.send("first");
    const second = harness.transport.send("second");

    await expect(failed).rejects.toThrow("Discord rejected the first send");
    await expect(second).resolves.toBeUndefined();
    expect(channel.sent.map(({ content }) => content)).toEqual(["first", "second"]);
  });
});

describe("DiscordTransport failures", () => {
  test("reports only the first client error", async () => {
    const harness = await createHarness();

    expect(() => harness.client.emit("error", new Error("socket failed"))).not.toThrow();
    expect(() => harness.client.emit("error", new Error("duplicate"))).not.toThrow();

    expect(harness.fatals).toHaveLength(1);
  });

  test("contains a throwing fatal callback inside the client error listener", async () => {
    const harness = await createHarness({
      onFatal: () => {
        throw new Error("fatal callback failed");
      },
    });

    expect(() => harness.client.emit("error", new Error("socket failed"))).not.toThrow();
    expect(harness.fatals).toHaveLength(1);
  });

  test("maps login rejection to DiscordStartupError and destroys the client", async () => {
    const client = new FakeClient();
    client.loginError = new Error("bad token");
    const transport = new DiscordTransport(() => client as unknown as Client);

    await expect(transport.start("bad-token", async () => {}, () => {})).rejects.toBeInstanceOf(
      DiscordStartupError,
    );
    expect(client.destroyCalls).toBe(1);
  });
});
