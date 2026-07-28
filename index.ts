import { loadConfig } from "./src/config.ts";
import { DiscordTransport } from "./src/discord.ts";
import { Marvin } from "./src/marvin.ts";
import { PiAssistant } from "./src/pi.ts";

const config = await loadConfig({
  env: process.env,
  defaultSessionDir: PiAssistant.defaultSessionDir(),
});
const assistant = await PiAssistant.create(config);
const discord = new DiscordTransport();
const onFatal = () => process.exit(1);
const marvin = new Marvin(assistant, discord.send.bind(discord), onFatal);

assistant.setOutcomeHandler(marvin.handleOutcome.bind(marvin));
await discord.start(config.discordToken, marvin.handle.bind(marvin), onFatal);
