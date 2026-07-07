import { describe, expect, test } from "bun:test";
import {
	createMarvinResponseClient,
	handleDiscordMessage,
	parseDiscordChannelAgents,
	writeDiscordLog,
	type DiscordLogEntry,
	type DiscordMessage,
	type DiscordThreadConversation,
	type MarvinFetch,
	type MarvinResponseRequest,
} from "../discord.ts";

type StoredThreadConversation = DiscordThreadConversation & {
	threadId: string;
};

const supportChannelId = "channel_support";
const supportThreadId = "thread_support_1";
const supportAgentId = "ag_support";
const supportConversationId = "conv_support_1";
const supportChannelAgents = new Map([[supportChannelId, supportAgentId]]);

function threadMessage(content: string): DiscordMessage {
	return {
		id: "message_1",
		content,
		channelId: supportThreadId,
		parentChannelId: supportChannelId,
		authorIsBot: false,
	};
}

describe("Discord adapter", () => {
	test("calls the Marvin responses API", async () => {
		const calls: {
			input: string | URL | Request;
			init: RequestInit | undefined;
		}[] = [];
		const fetcher: MarvinFetch = async (input, init) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					message: "API reply",
					conversation_id: "conv_api",
				}),
			);
		};
		const marvinApiUrl = ["http:", "", "marvin.local"].join("/");
		const client = createMarvinResponseClient(marvinApiUrl, fetcher);

		expect(
			await client({
				agent_id: supportAgentId,
				message: "Need help",
			}),
		).toEqual({
			message: "API reply",
			conversation_id: "conv_api",
		});
		expect(calls).toEqual([
			{
				input: `${marvinApiUrl}/responses`,
				init: {
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify({
						agent_id: supportAgentId,
						message: "Need help",
					}),
				},
			},
		]);
	});
});

test("writes Discord logs as JSON lines", () => {
	const writes: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		writes.push(chunk.toString());
		return true;
	};

	writeDiscordLog({
		type: "discord.bot.start",
		configured_channels: 1,
	});

	process.stdout.write = originalWrite;

	expect(writes).toEqual([
		'{"type":"discord.bot.start","configured_channels":1}\n',
	]);
});

describe("Discord adapter", () => {
	test("parses channel-to-agent configuration", () => {
		expect(
			Array.from(
				parseDiscordChannelAgents(
					`${supportChannelId}=${supportAgentId},channel_engineering=ag_engineering`,
				).entries(),
			),
		).toEqual([
			[supportChannelId, supportAgentId],
			["channel_engineering", "ag_engineering"],
		]);
	});

	test("creates a Marvin conversation for the first message in a Discord thread", async () => {
		const requests: MarvinResponseRequest[] = [];
		const conversations = new Map<string, StoredThreadConversation>();
		const logs: DiscordLogEntry[] = [];
		const action = await handleDiscordMessage(
			threadMessage("Need billing help"),
			{
				channelAgents: supportChannelAgents,
				getThreadConversation: (threadId) => conversations.get(threadId),
				saveThreadConversation: (threadId, conversation) => {
					conversations.set(threadId, { threadId, ...conversation });
				},
				createResponse: async (request) => {
					requests.push(request);
					return {
						message: "I can help with billing.",
						conversation_id: supportConversationId,
					};
				},
				log: (entry) => {
					logs.push(entry);
				},
			},
		);

		expect(requests).toEqual([
			{
				agent_id: supportAgentId,
				message: "Need billing help",
			},
		]);
		expect(conversations.get(supportThreadId)).toEqual({
			threadId: supportThreadId,
			channelId: supportChannelId,
			agentId: supportAgentId,
			conversationId: supportConversationId,
		});
		expect(action).toEqual({
			type: "reply",
			content: "I can help with billing.",
		});
		expect(logs).toEqual([
			{
				type: "discord.message.received",
				message_id: "message_1",
				channel_id: supportThreadId,
				parent_channel_id: supportChannelId,
			},
			{
				type: "discord.response.request",
				message_id: "message_1",
				thread_id: supportThreadId,
				agent_id: supportAgentId,
				conversation: "new",
			},
			{
				type: "discord.message.reply",
				message_id: "message_1",
				thread_id: supportThreadId,
				agent_id: supportAgentId,
				conversation_id: supportConversationId,
			},
		]);
	});

	test("continues the stored Marvin conversation for later messages in the same Discord thread", async () => {
		const requests: MarvinResponseRequest[] = [];
		const conversations = new Map<string, StoredThreadConversation>([
			[
				supportThreadId,
				{
					threadId: supportThreadId,
					channelId: supportChannelId,
					agentId: supportAgentId,
					conversationId: supportConversationId,
				},
			],
		]);
		const action = await handleDiscordMessage(
			threadMessage("Can you explain that?"),
			{
				channelAgents: supportChannelAgents,
				getThreadConversation: (threadId) => conversations.get(threadId),
				saveThreadConversation: (threadId, conversation) => {
					conversations.set(threadId, { threadId, ...conversation });
				},
				createResponse: async (request) => {
					requests.push(request);
					return {
						message: "Here is more detail.",
						conversation_id: supportConversationId,
					};
				},
				log: () => {},
			},
		);

		expect(requests).toEqual([
			{
				agent_id: supportAgentId,
				conversation_id: supportConversationId,
				message: "Can you explain that?",
			},
		]);
		expect(action).toEqual({
			type: "reply",
			content: "Here is more detail.",
		});
	});

	test("ignores parent-channel messages because conversations are thread-scoped", async () => {
		const requests: MarvinResponseRequest[] = [];
		const logs: DiscordLogEntry[] = [];
		const action = await handleDiscordMessage(
			{
				id: "message_2",
				content: "Can the bot answer here?",
				channelId: supportChannelId,
				parentChannelId: null,
				authorIsBot: false,
			},
			{
				channelAgents: supportChannelAgents,
				getThreadConversation: () => undefined,
				saveThreadConversation: () => {},
				createResponse: async (request) => {
					requests.push(request);
					return {
						message: "This should not be sent.",
						conversation_id: "conv_unused",
					};
				},
				log: (entry) => {
					logs.push(entry);
				},
			},
		);

		expect(requests).toEqual([]);
		expect(action).toEqual({ type: "ignore" });
		expect(logs).toEqual([
			{
				type: "discord.message.received",
				message_id: "message_2",
				channel_id: supportChannelId,
				parent_channel_id: null,
			},
			{
				type: "discord.message.ignore",
				reason: "not_thread",
				message_id: "message_2",
				channel_id: supportChannelId,
			},
		]);
	});
});
