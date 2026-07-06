import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
// pi-lens-ignore: ast-grep:find-import-file-without-extension
import { drizzle } from "drizzle-orm/bun-sqlite";
// pi-lens-ignore: ast-grep:find-import-file-without-extension
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const databasePath = process.env.AGENTS_DB_PATH ?? "agents.sqlite";

const sqlite = new Database(databasePath);

sqlite.run(`
	CREATE TABLE IF NOT EXISTS agents (
		id text PRIMARY KEY,
		name text NOT NULL,
		description text,
		instructions text NOT NULL,
		model text NOT NULL,
		tools text
	)
`);

sqlite.run(`
	CREATE TABLE IF NOT EXISTS conversations (
		id text PRIMARY KEY,
		agent_id text NOT NULL,
		messages text NOT NULL,
		created_at text NOT NULL,
		updated_at text NOT NULL
	)
`);

const database = drizzle({ client: sqlite });

const agentsTable = sqliteTable("agents", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	instructions: text("instructions").notNull(),
	model: text("model").notNull(),
	tools: text("tools"),
});

const conversationsTable = sqliteTable("conversations", {
	id: text("id").primaryKey(),
	agentId: text("agent_id").notNull(),
	messages: text("messages").notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

export type AgentRow = typeof agentsTable.$inferSelect;
export type NewAgentRow = AgentRow;
export type ConversationRow = typeof conversationsTable.$inferSelect;
export type NewConversationRow = ConversationRow;

export type AgentUpdate = {
	name?: string;
	description?: string | null;
	instructions?: string;
	model?: string;
	tools?: string | null;
};

export type DeleteAgentResult = "deleted" | "alreadyDeleted" | "missing";

const deletedAgentIds = new Set<string>();

export function createAgent(agent: NewAgentRow): AgentRow {
	database.insert(agentsTable).values(agent).run();
	return agent;
}

export function createConversation(
	conversation: NewConversationRow,
): ConversationRow {
	database.insert(conversationsTable).values(conversation).run();
	return conversation;
}

export function getAgent(id: string): AgentRow | undefined {
	return database
		.select()
		.from(agentsTable)
		.where(eq(agentsTable.id, id))
		.get();
}

export function listAgents(): AgentRow[] {
	const agents = database.select().from(agentsTable).all();
	agents.sort((left, right) => left.id.localeCompare(right.id));
	return agents;
}

export function getConversation(id: string): ConversationRow | undefined {
	return database
		.select()
		.from(conversationsTable)
		.where(eq(conversationsTable.id, id))
		.get();
}

export function updateConversationMessages(
	id: string,
	messages: string,
	updatedAt: string,
): ConversationRow | undefined {
	database
		.update(conversationsTable)
		.set({ messages, updatedAt })
		.where(eq(conversationsTable.id, id))
		.run();
	return getConversation(id);
}

export function updateAgent(
	id: string,
	changes: AgentUpdate,
): AgentRow | undefined {
	database.update(agentsTable).set(changes).where(eq(agentsTable.id, id)).run();
	return getAgent(id);
}

export function deleteAgent(id: string): DeleteAgentResult {
	const agent = getAgent(id);

	if (agent === undefined) {
		if (deletedAgentIds.has(id)) {
			return "alreadyDeleted";
		}

		return "missing";
	}

	database.delete(agentsTable).where(eq(agentsTable.id, id)).run();
	deletedAgentIds.add(id);
	return "deleted";
}
