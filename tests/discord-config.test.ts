import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { loadDiscordBotEnvironment } from "../discord-config.ts";

const testDirectory = mkdtempSync(join(tmpdir(), "marvin-discord-config-"));
const envPath = join(testDirectory, ".env");
const originalDiscordToken = process.env.DISCORD_TOKEN;
const originalMarvinApiUrl = process.env.MARVIN_API_URL;
const originalDiscordChannelAgents = process.env.DISCORD_CHANNEL_AGENTS;

beforeEach(() => {
	unsetEnvironmentVariable("DISCORD_TOKEN");
	unsetEnvironmentVariable("MARVIN_API_URL");
	unsetEnvironmentVariable("DISCORD_CHANNEL_AGENTS");
});

afterEach(() => {
	restoreEnvironmentVariable("DISCORD_TOKEN", originalDiscordToken);
	restoreEnvironmentVariable("MARVIN_API_URL", originalMarvinApiUrl);
	restoreEnvironmentVariable(
		"DISCORD_CHANNEL_AGENTS",
		originalDiscordChannelAgents,
	);
});

afterAll(() => {
	rmSync(testDirectory, { recursive: true, force: true });
});

function unsetEnvironmentVariable(name: string): void {
	Reflect.deleteProperty(process.env, name);
}

function restoreEnvironmentVariable(
	name: string,
	value: string | undefined,
): void {
	if (value === undefined) {
		unsetEnvironmentVariable(name);
		return;
	}

	process.env[name] = value;
}

describe("Discord config", () => {
	test("loads Discord bot environment variables from a .env file", () => {
		writeFileSync(
			envPath,
			[
				"DISCORD_TOKEN=discord_token_from_env_file",
				"MARVIN_API_URL=http://localhost:3000",
				"DISCORD_CHANNEL_AGENTS=channel_support=ag_support",
			].join("\n"),
		);

		expect(loadDiscordBotEnvironment(envPath)).toEqual({
			discordToken: "discord_token_from_env_file",
			marvinApiUrl: "http://localhost:3000",
			discordChannelAgents: "channel_support=ag_support",
		});
	});
});
