import { describe, expect, test } from "bun:test";
import { Marvin } from "../src/marvin.ts";
import type { Admission, AssistantOutcome } from "../src/pi.ts";

interface HarnessOptions {
  admission?: Admission;
  send?: (text: string) => Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  const admitted: string[] = [];
  const sent: string[] = [];
  const fatals: true[] = [];
  const assistant = {
    async admit(text: string): Promise<Admission> {
      admitted.push(text);
      return options.admission ?? { kind: "started" };
    },
  };
  const send =
    options.send ??
    (async (text: string) => {
      sent.push(text);
    });
  const marvin = new Marvin(assistant, send, () => {
    fatals.push(true);
  });

  return { admitted, fatals, marvin, sent };
}

describe("Marvin admission handling", () => {
  test.each([
    [{ kind: "busy" } satisfies Admission, "Marvin is already working; try again after it finishes."],
    [
      { kind: "unavailable" } satisfies Admission,
      "Marvin is temporarily unavailable; try again in a moment.",
    ],
    [
      { kind: "failed", fatal: false } satisfies Admission,
      "I couldn't accept that request. Retry it.",
    ],
  ])("maps %o to its response", async (admission, expected) => {
    const harness = createHarness({ admission });

    await harness.marvin.handle({ type: "prompt", text: " original prompt " });

    expect(harness.admitted).toEqual([" original prompt "]);
    expect(harness.sent).toEqual([expected]);
    expect(harness.fatals).toEqual([]);
  });

  test("does not send an acknowledgement when work starts", async () => {
    const harness = createHarness({ admission: { kind: "started" } });

    await harness.marvin.handle({ type: "prompt", text: "hello" });

    expect(harness.admitted).toEqual(["hello"]);
    expect(harness.sent).toEqual([]);
  });

  test("maps a fatal admission failure and reports it after sending", async () => {
    const harness = createHarness({
      admission: { kind: "failed", fatal: true },
    });

    await harness.marvin.handle({ type: "prompt", text: "hello" });

    expect(harness.sent).toEqual([
      "I couldn't accept that request. Marvin must restart.",
    ]);
    expect(harness.fatals).toEqual([true]);
  });

  test("reports a fatal admission even when its response cannot be sent", async () => {
    const harness = createHarness({
      admission: { kind: "failed", fatal: true },
      send: async () => {
        throw new Error("send failed");
      },
    });

    await expect(harness.marvin.handle({ type: "prompt", text: "hello" })).rejects.toThrow(
      "send failed",
    );
    expect(harness.fatals).toEqual([true]);
  });

  test("answers attachment-only ingress without admitting it", async () => {
    const harness = createHarness();

    await harness.marvin.handle({ type: "attachment_only" });

    expect(harness.admitted).toEqual([]);
    expect(harness.sent).toEqual(["Text messages only for now."]);
  });
});

describe("Marvin outcome handling", () => {
  test.each([
    [{ type: "answer", text: "The answer." } satisfies AssistantOutcome, "The answer."],
    [
      { type: "answer", text: "" } satisfies AssistantOutcome,
      "I finished, but there was no text response.",
    ],
    [
      { type: "failure", reason: "request_failed" } satisfies AssistantOutcome,
      "I couldn't complete that request. Retry it.",
    ],
  ])("maps %o to its response", (outcome, expected) => {
    const harness = createHarness();

    harness.marvin.handleOutcome(outcome);

    expect(harness.sent).toEqual([expected]);
    expect(harness.fatals).toEqual([]);
  });

  test("maps a fatal outcome and reports it", () => {
    const harness = createHarness();

    harness.marvin.handleOutcome({
      type: "fatal",
      reason: "runtime_failed",
    });

    expect(harness.sent).toEqual([
      "I couldn't complete that request. Marvin must restart.",
    ]);
    expect(harness.fatals).toEqual([true]);
  });

  test.each(["throw", "reject"])("isolates the outcome handler when send operations %s", async (mode) => {
    const send = (_text: string): Promise<void> => {
      if (mode === "throw") {
        throw new Error("synchronous send failure");
      }
      return Promise.reject(new Error("asynchronous send failure"));
    };
    const harness = createHarness({ send });

    expect(() => harness.marvin.handleOutcome({ type: "answer", text: "hello" })).not.toThrow();
    await Promise.resolve();
  });
});
