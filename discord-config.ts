import { config } from "dotenv";

export type DiscordBotEnvironment = {
	discordToken: string;
	marvinApiUrl: string;
	discordChannelAgents: string;
};

export function loadDiscordBotEnvironment(
	path = ".env",
): DiscordBotEnvironment {
	config({ path, quiet: true });

	return {
		discordToken: requiredEnvironmentVariable("DISCORD_TOKEN"),
		marvinApiUrl: requiredEnvironmentVariable("MARVIN_API_URL"),
		discordChannelAgents: requiredEnvironmentVariable("DISCORD_CHANNEL_AGENTS"),
	};
}

function requiredEnvironmentVariable(name: string): string {
	const value = process.env[name];

	if (value === undefined || value.length === 0) {
		throw new Error(`missing ${name}`);
	}

	return value;
}
