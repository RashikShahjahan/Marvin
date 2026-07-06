import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseAgentMessages } from "./agent.ts";

const testDirectory = mkdtempSync(join(tmpdir(), "marvin-conversations-"));
const databasePath = join(testDirectory, "agents.sqlite");
const originalDatabasePath = process.env.AGENTS_DB_PATH;

let sqlite: Database;
let db: typeof import("./db.ts");

beforeAll(async () => {
	process.env.AGENTS_DB_PATH = databasePath;
	db = await import(`./db.ts?conversations=${Date.now()}`);
	sqlite = new Database(databasePath, {
		readonly: true,
		create: false,
	});
});

afterAll(() => {
	sqlite.close();

	process.env.AGENTS_DB_PATH = originalDatabasePath;

	rmSync(testDirectory, { recursive: true, force: true });
});

type TableRow = {
	name: string;
};

describe("conversations database support", () => {
	test("creates the conversations table", () => {
		const row = sqlite
			.query<TableRow, [string]>(
				`SELECT name
				FROM sqlite_master
				WHERE type = 'table' AND name = ?`,
			)
			.get("conversations");

		expect(row?.name).toBe("conversations");
	});

	test("creates and updates conversation messages", () => {
		const now = new Date().toISOString();
		db.createAgent({
			id: "ag_conversation_unit",
			name: "Conversation Unit Agent",
			description: null,
			instructions: "Reply briefly.",
			model: "gpt-4.1",
			tools: null,
		});

		db.createConversation({
			id: "conv_unit",
			agentId: "ag_conversation_unit",
			messages: "[]",
			createdAt: now,
			updatedAt: now,
		});

		expect(db.getConversation("conv_unit")?.messages).toBe("[]");

		const updatedAt = new Date(Date.now() + 1_000).toISOString();
		const messages = JSON.stringify([
			{
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			},
		]);
		const conversation = db.updateConversationMessages(
			"conv_unit",
			messages,
			updatedAt,
		);

		expect(conversation?.messages).toBe(messages);
		expect(conversation?.updatedAt).toBe(updatedAt);
	});
});

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
