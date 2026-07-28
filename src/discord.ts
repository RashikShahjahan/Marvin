import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
  type DMChannel,
  type Message,
} from "discord.js";
import { splitMessage } from "./split-message.ts";

export type DiscordIngress = { type: "prompt"; text: string } | { type: "attachment_only" };
export type IngressHandler = (event: DiscordIngress) => Promise<void>;
export type DiscordClientFactory = (options: ClientOptions) => Client;

export class DiscordStartupError extends Error {
  constructor() {
    super("discord_failed");
    this.name = "DiscordStartupError";
  }
}

export class DiscordTransport {
  private client?: Client;
  private destination?: DMChannel;
  private fatalReported = false;

  constructor(
    private readonly clientFactory: DiscordClientFactory = (options) => new Client(options),
  ) {}

  async start(
    token: string,
    onIngress: IngressHandler,
    onFatal: () => void,
  ): Promise<void> {
    if (this.client) {
      throw new DiscordStartupError();
    }

    const client = this.clientFactory({
      intents: [GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    this.client = client;

    client.on("messageCreate", (message) => {
      const ingress = this.toIngress(message);
      if (!ingress) {
        return;
      }
      this.destination ??= message.channel as DMChannel;
      try {
        void onIngress(ingress).catch(() => {});
      } catch {
        // EventEmitter listeners must not throw into discord.js.
      }
    });

    client.on("error", () => {
      if (this.fatalReported) {
        return;
      }
      this.fatalReported = true;
      try {
        onFatal();
      } catch {
        // EventEmitter listeners must not throw into discord.js.
      }
    });

    try {
      await client.login(token);
    } catch {
      client.removeAllListeners();
      client.destroy();
      throw new DiscordStartupError();
    }
  }

  async send(text: string): Promise<void> {
    if (!this.destination) {
      throw new Error("Discord destination is not available");
    }

    for (const content of splitMessage(text)) {
      await this.destination.send({
        content,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  }

  private toIngress(message: Message): DiscordIngress | undefined {
    if (message.author.bot || message.channel.type !== ChannelType.DM) {
      return undefined;
    }

    if (message.content.trim() === "") {
      return message.attachments.size > 0 ? { type: "attachment_only" } : undefined;
    }
    return { type: "prompt", text: message.content };
  }
}
