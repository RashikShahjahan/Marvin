import { describe, expect, test } from "bun:test";
import { parseAgentMessages } from "../../agent.ts";

describe("conversation message parsing", () => {
	test("parses stored agent messages", () => {
		const messages = JSON.stringify([
			{
				role: "user",
				content: "Remember this.",
				timestamp: Date.now(),
			},
		]);

		expect(parseAgentMessages(messages)).toHaveLength(1);
	});

	test("rejects invalid stored messages", () => {
		expect(parseAgentMessages("not json")).toBeUndefined();
		expect(
			parseAgentMessages(JSON.stringify([{ role: "system" }])),
		).toBeUndefined();
	});
});
