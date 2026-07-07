import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type DiscordThreadConversation = {
	channelId: string;
	agentId: string;
	conversationId: string;
};

type DiscordStorageModule = {
	setDiscordChannelAgent: (channelId: string, agentId: string) => void;
	getDiscordChannelAgent: (channelId: string) => string | undefined;
	saveDiscordThreadConversation: (
		threadId: string,
		conversation: DiscordThreadConversation,
	) => void;
	getDiscordThreadConversation: (
		threadId: string,
	) => DiscordThreadConversation | undefined;
};

const testDirectory = mkdtempSync(join(tmpdir(), "marvin-discord-storage-"));
process.env.AGENTS_DB_PATH = join(testDirectory, "agents.sqlite");

let db: DiscordStorageModule;

beforeAll(async () => {
	const imported = await import("../db.ts");

	if (!isDiscordStorageModule(imported)) {
		throw new Error("expected Discord storage module");
	}

	db = imported;
});

afterAll(() => {
	rmSync(testDirectory, { recursive: true, force: true });
});

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiscordStorageModule(value: unknown): value is DiscordStorageModule {
	return (
		isObject(value) &&
		typeof value.setDiscordChannelAgent === "function" &&
		typeof value.getDiscordChannelAgent === "function" &&
		typeof value.saveDiscordThreadConversation === "function" &&
		typeof value.getDiscordThreadConversation === "function"
	);
}

describe("Discord storage", () => {
	test("stores the Marvin agent configured for a Discord channel", () => {
		db.setDiscordChannelAgent("channel_support", "ag_support");

		expect(db.getDiscordChannelAgent("channel_support")).toBe("ag_support");
	});

	test("updates the Marvin agent configured for a Discord channel", () => {
		db.setDiscordChannelAgent("channel_engineering", "ag_engineering_v1");
		db.setDiscordChannelAgent("channel_engineering", "ag_engineering_v2");

		expect(db.getDiscordChannelAgent("channel_engineering")).toBe(
			"ag_engineering_v2",
		);
	});

	test("stores the Marvin conversation for a Discord thread", () => {
		db.saveDiscordThreadConversation("thread_billing", {
			channelId: "channel_support",
			agentId: "ag_support",
			conversationId: "conv_billing",
		});

		expect(db.getDiscordThreadConversation("thread_billing")).toEqual({
			channelId: "channel_support",
			agentId: "ag_support",
			conversationId: "conv_billing",
		});
	});
});
