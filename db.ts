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

sqlite.run(`
	CREATE TABLE IF NOT EXISTS discord_channel_agents (
		channel_id text PRIMARY KEY,
		agent_id text NOT NULL
	)
`);

sqlite.run(`
	CREATE TABLE IF NOT EXISTS discord_thread_conversations (
		thread_id text PRIMARY KEY,
		channel_id text NOT NULL,
		agent_id text NOT NULL,
		conversation_id text NOT NULL
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

const discordChannelAgentsTable = sqliteTable("discord_channel_agents", {
	channelId: text("channel_id").primaryKey(),
	agentId: text("agent_id").notNull(),
});

const discordThreadConversationsTable = sqliteTable(
	"discord_thread_conversations",
	{
		threadId: text("thread_id").primaryKey(),
		channelId: text("channel_id").notNull(),
		agentId: text("agent_id").notNull(),
		conversationId: text("conversation_id").notNull(),
	},
);

export type AgentRow = typeof agentsTable.$inferSelect;
export type NewAgentRow = AgentRow;
export type ConversationRow = typeof conversationsTable.$inferSelect;
export type NewConversationRow = ConversationRow;
export type DiscordThreadConversation = Omit<
	typeof discordThreadConversationsTable.$inferSelect,
	"threadId"
>;

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

export function setDiscordChannelAgent(
	channelId: string,
	agentId: string,
): void {
	database
		.insert(discordChannelAgentsTable)
		.values({ channelId, agentId })
		.onConflictDoUpdate({
			target: discordChannelAgentsTable.channelId,
			set: { agentId },
		})
		.run();
}

export function getDiscordChannelAgent(channelId: string): string | undefined {
	const row = database
		.select({ agentId: discordChannelAgentsTable.agentId })
		.from(discordChannelAgentsTable)
		.where(eq(discordChannelAgentsTable.channelId, channelId))
		.get();

	return row?.agentId;
}

export function saveDiscordThreadConversation(
	threadId: string,
	conversation: DiscordThreadConversation,
): void {
	database
		.insert(discordThreadConversationsTable)
		.values({ threadId, ...conversation })
		.onConflictDoUpdate({
			target: discordThreadConversationsTable.threadId,
			set: conversation,
		})
		.run();
}

export function getDiscordThreadConversation(
	threadId: string,
): DiscordThreadConversation | undefined {
	return database
		.select({
			channelId: discordThreadConversationsTable.channelId,
			agentId: discordThreadConversationsTable.agentId,
			conversationId: discordThreadConversationsTable.conversationId,
		})
		.from(discordThreadConversationsTable)
		.where(eq(discordThreadConversationsTable.threadId, threadId))
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
