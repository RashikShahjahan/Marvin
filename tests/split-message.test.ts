import { describe, expect, test } from "bun:test";
import { splitMessage } from "../src/split-message.ts";

describe("splitMessage input validation", () => {
  test("returns no chunks for an empty message", () => {
    expect(splitMessage("")).toEqual([]);
  });

  test("requires a safe integer limit of at least two", () => {
    for (const limit of [Number.MIN_SAFE_INTEGER, -1, 0, 1, 1.5, NaN, Infinity, 2 ** 53]) {
      expect(() => splitMessage("text", limit)).toThrow(
        new RangeError("limit must be a safe integer of at least 2"),
      );
    }
  });

  test("accepts the minimum limit", () => {
    expect(splitMessage("abcd", 2)).toEqual(["ab", "cd"]);
  });
});

describe("splitMessage boundary selection", () => {
  test("does not split a message that already fits, including at the exact limit", () => {
    expect(splitMessage("one two\nthree", 13)).toEqual(["one two\nthree"]);
  });

  test("hard-splits an uninterrupted word without losing content", () => {
    expect(splitMessage("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });

  test("prefers the last paragraph boundary over later weaker boundaries", () => {
    const chunks = splitMessage("aa\n\nbb\ncc ddzz", 11);

    expect(chunks[0]).toBe("aa\n\n");
    expect(chunks.join("")).toBe("aa\n\nbb\ncc ddzz");
  });

  test("prefers the last newline when there is no paragraph boundary", () => {
    const chunks = splitMessage("alpha\nbeta gamma", 11);

    expect(chunks[0]).toBe("alpha\n");
    expect(chunks.join("")).toBe("alpha\nbeta gamma");
  });

  test("falls back to the last whitespace and retains it in the preceding chunk", () => {
    expect(splitMessage("alpha beta gamma", 11)).toEqual(["alpha beta ", "gamma"]);
  });

  test("recognizes Unicode whitespace as a soft boundary", () => {
    expect(splitMessage("alpha\u00a0beta-gamma", 11)[0]).toBe("alpha\u00a0");
  });

  test("uses the default 2,000 UTF-16-code-unit limit", () => {
    const chunks = splitMessage("x".repeat(2_001));

    expect(chunks.map((chunk) => chunk.length)).toEqual([2_000, 1]);
  });
});

describe("splitMessage lossless Unicode invariants", () => {
  test("never separates a valid surrogate pair at a hard boundary", () => {
    expect(splitMessage("A😀B", 2)).toEqual(["A", "😀", "B"]);
    expect(splitMessage("😀😀😀", 3)).toEqual(["😀", "😀", "😀"]);
  });

  test("reconstructs representative messages exactly with every valid small limit", () => {
    const messages = [
      "plain uninterrupted text",
      "words separated by several spaces and\ttabs",
      "first line\nsecond line\n\nfourth paragraph",
      "ASCII 😀 emoji 🚀 stay whole",
      "non-breaking\u00a0space and ideographic\u3000space",
      "😀😀😀😀😀",
    ];

    for (const source of messages) {
      for (let limit = 2; limit <= 12; limit += 1) {
        const chunks = splitMessage(source, limit);

        expect(chunks.join("")).toBe(source);
        expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= limit)).toBe(true);
        for (const chunk of chunks) {
          const first = chunk.charCodeAt(0);
          const last = chunk.charCodeAt(chunk.length - 1);
          expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
          expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        }
      }
    }
  });
});
