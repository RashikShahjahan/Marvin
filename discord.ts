import { z } from "zod";

const marvinResponseSchema = z.object({
	message: z.string(),
	conversation_id: z.string(),
});

export type DiscordMessage = {
	id: string;
	content: string;
	channelId: string;
	parentChannelId: string | null;
	authorIsBot: boolean;
};

export type DiscordThreadConversation = {
	channelId: string;
	agentId: string;
	conversationId: string;
};

export type MarvinResponseRequest = {
	agent_id: string;
	conversation_id?: string;
	message: string;
};

export type MarvinResponse = z.infer<typeof marvinResponseSchema>;

export type MarvinFetch = (
	input: string | URL | Request,
	init: RequestInit | undefined,
) => Promise<Response>;

export type DiscordAdapterDependencies = {
	channelAgents: ReadonlyMap<string, string>;
	getThreadConversation: (
		threadId: string,
	) => DiscordThreadConversation | undefined;
	saveThreadConversation: (
		threadId: string,
		conversation: DiscordThreadConversation,
	) => void;
	createResponse: (request: MarvinResponseRequest) => Promise<MarvinResponse>;
};

export type DiscordMessageAction =
	| {
			type: "ignore";
	  }
	| {
			type: "reply";
			content: string;
	  };

export function createMarvinResponseClient(
	apiUrl: string,
	fetcher: MarvinFetch,
): (request: MarvinResponseRequest) => Promise<MarvinResponse> {
	return async function createResponse(
		request: MarvinResponseRequest,
	): Promise<MarvinResponse> {
		const response = await fetcher(`${apiUrl}/responses`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(request),
		});

		return marvinResponseSchema.parse(await response.json());
	};
}

export function parseDiscordChannelAgents(value: string): Map<string, string> {
	const channelAgents = new Map<string, string>();

	for (const mapping of value.split(",")) {
		const [channelId, agentId, extra] = mapping.split("=");

		if (
			channelId === undefined ||
			agentId === undefined ||
			extra !== undefined ||
			channelId.length === 0 ||
			agentId.length === 0
		) {
			throw new Error("expected Discord channel agent mapping");
		}

		channelAgents.set(channelId, agentId);
	}

	return channelAgents;
}

export async function handleDiscordMessage(
	message: DiscordMessage,
	dependencies: DiscordAdapterDependencies,
): Promise<DiscordMessageAction> {
	if (message.authorIsBot || message.parentChannelId === null) {
		return { type: "ignore" };
	}

	const agentId = dependencies.channelAgents.get(message.parentChannelId);

	if (agentId === undefined) {
		return { type: "ignore" };
	}

	const existingConversation = dependencies.getThreadConversation(
		message.channelId,
	);
	const request: MarvinResponseRequest = {
		agent_id: agentId,
		...(existingConversation === undefined
			? {}
			: { conversation_id: existingConversation.conversationId }),
		message: message.content,
	};
	const response = await dependencies.createResponse(request);

	dependencies.saveThreadConversation(message.channelId, {
		channelId: message.parentChannelId,
		agentId,
		conversationId: response.conversation_id,
	});

	return {
		type: "reply",
		content: response.message,
	};
}
