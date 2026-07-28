import type { DiscordIngress } from "./discord.ts";
import type { Admission, AssistantOutcome } from "./pi.ts";

const EMPTY_ANSWER = "I finished, but there was no text response.";

interface AssistantDependency {
  admit(text: string): Promise<Admission>;
}

type Send = (text: string) => Promise<void>;
type FatalHandler = () => void;

export class Marvin {
  constructor(
    private readonly assistant: AssistantDependency,
    private readonly send: Send,
    private readonly onFatal: FatalHandler,
  ) {}

  async handle(event: DiscordIngress): Promise<void> {
    if (event.type === "attachment_only") {
      await this.send("Text messages only for now.");
      return;
    }
    const admission = await this.assistant.admit(event.text);
    switch (admission.kind) {
      case "started":
        return;
      case "busy":
        await this.send("Marvin is already working; try again after it finishes.");
        return;
      case "unavailable":
        await this.send("Marvin is temporarily unavailable; try again in a moment.");
        return;
      case "failed":
        if (admission.fatal) {
          try {
            await this.send("I couldn't accept that request. Marvin must restart.");
          } finally {
            this.onFatal();
          }
        } else {
          await this.send("I couldn't accept that request. Retry it.");
        }
    }
  }

  handleOutcome(outcome: AssistantOutcome): void {
    switch (outcome.type) {
      case "answer":
        this.sendOutcome(outcome.text || EMPTY_ANSWER);
        return;
      case "failure":
        this.sendOutcome("I couldn't complete that request. Retry it.");
        return;
      case "fatal":
        this.sendOutcome("I couldn't complete that request. Marvin must restart.");
        this.onFatal();
    }
  }

  private sendOutcome(text: string): void {
    try {
      void this.send(text).catch(() => {});
    } catch {
      // A structural test double may throw synchronously; Pi callbacks must remain isolated.
    }
  }
}
