import {
	Client,
	Events,
	GatewayIntentBits,
	Partials,
	type Message,
} from "discord.js";
import { loadDiscordBotEnvironment } from "./discord-config.ts";
import {
	createMarvinResponseClient,
	handleDiscordMessage,
	parseDiscordChannelAgents,
	type DiscordMessage,
	type MarvinFetch,
} from "./discord.ts";
import {
	getDiscordThreadConversation,
	saveDiscordThreadConversation,
} from "./db.ts";

const environment = loadDiscordBotEnvironment();
const discordToken = environment.discordToken;
const marvinApiUrl = environment.marvinApiUrl;
const channelAgents = parseDiscordChannelAgents(
	environment.discordChannelAgents,
);
const marvinResponsesUrl = marvinResponsesEndpoint(marvinApiUrl);
const marvinFetch: MarvinFetch = (_input, init) =>
	fetch(marvinResponsesUrl, init);
const createResponse = createMarvinResponseClient(marvinApiUrl, marvinFetch);
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel],
});

client.on(Events.MessageCreate, async (message) => {
	const action = await handleDiscordMessage(toDiscordMessage(message), {
		channelAgents,
		getThreadConversation: getDiscordThreadConversation,
		saveThreadConversation: saveDiscordThreadConversation,
		createResponse,
	});

	if (action.type === "reply") {
		await message.reply(action.content);
	}
});

await client.login(discordToken);

function toDiscordMessage(message: Message): DiscordMessage {
	return {
		id: message.id,
		content: message.content,
		channelId: message.channelId,
		parentChannelId: message.channel.isThread()
			? message.channel.parentId
			: null,
		authorIsBot: message.author.bot,
	};
}

function marvinResponsesEndpoint(apiUrl: string): string {
	const url = new URL("/responses", apiUrl);

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("expected HTTP Marvin API URL");
	}

	return url.toString();
}
