import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core"; // pi-lens-ignore: ast-grep:find-import-file-without-extension
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent"; // pi-lens-ignore: ast-grep:find-import-file-without-extension
import type {
	AssistantMessage,
	Credential,
	CredentialStore,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai"; // pi-lens-ignore: ast-grep:find-import-file-without-extension
import {
	builtinModels,
	getBuiltinModel,
} from "@earendil-works/pi-ai/providers/all"; // pi-lens-ignore: ast-grep:find-import-file-without-extension
import { z } from "zod";

const defaultModel = getBuiltinModel("openai-codex", "gpt-5.5");
const authPath = join(homedir(), ".pi", "agent", "auth.json");

const apiKeyCredentialSchema = z.object({
	type: z.literal("api_key"),
	key: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
});
const oauthCredentialSchema = z
	.object({
		type: z.literal("oauth"),
		refresh: z.string(),
		access: z.string(),
		expires: z.number(),
	})
	.catchall(z.unknown());
const credentialSchema = z.union([
	apiKeyCredentialSchema,
	oauthCredentialSchema,
]);
const authFileSchema = z.record(z.string(), credentialSchema);

type AuthFile = z.infer<typeof authFileSchema>;

class PiAuthCredentialStore implements CredentialStore {
	async read(providerId: string): Promise<Credential | undefined> {
		return this.readAuthFile()[providerId];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const credentials = this.readAuthFile();
		const next = await fn(credentials[providerId]);

		if (next !== undefined) {
			credentials[providerId] = next;
			this.writeAuthFile(credentials);
		}

		return next ?? credentials[providerId];
	}

	delete(providerId: string): Promise<void> {
		const credentials = this.readAuthFile();
		delete credentials[providerId];
		this.writeAuthFile(credentials);
		return Promise.resolve();
	}

	private readAuthFile(): AuthFile {
		try {
			return authFileSchema.parse(JSON.parse(readFileSync(authPath, "utf-8")));
		} catch (error) {
			throw new Error(`failed to read pi auth: ${String(error)}`);
		}
	}

	private writeAuthFile(credentials: AuthFile): void {
		writeFileSync(authPath, `${JSON.stringify(credentials, null, 2)}\n`, {
			mode: 0o600,
		});
	}
}

const models = builtinModels({
	credentials: new PiAuthCredentialStore(),
});

const responseToolNameSchema = z.enum(["read", "write", "edit", "bash"]);
const responseToolNamesSchema = z.array(responseToolNameSchema);
const responseToolCwd = import.meta.dir;

const responseToolRegistry = {
	read: createReadTool(responseToolCwd),
	write: createWriteTool(responseToolCwd),
	edit: createEditTool(responseToolCwd),
	bash: createBashTool(responseToolCwd),
};

type ResponseToolName = z.infer<typeof responseToolNameSchema>;
type ResponseTool = (typeof responseToolRegistry)[ResponseToolName];

function responseTools(toolNames: string[]): ResponseTool[] {
	return responseToolNamesSchema
		.parse(toolNames)
		.map((toolName) => responseToolRegistry[toolName]);
}

type MessageContentBlock =
	| TextContent
	| ImageContent
	| ThinkingContent
	| ToolCall;

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return message.role === "assistant";
}

function isTextContent(content: MessageContentBlock): content is TextContent {
	return content.type === "text";
}

function contentText(content: string | MessageContentBlock[]): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.flatMap((block) => (isTextContent(block) ? [block.text] : []))
		.join("");
}

export async function createAgentResponse(
	instructions: string,
	message: string,
	toolNames: string[],
): Promise<string> {
	const agent = new Agent({
		initialState: {
			model: defaultModel,
			thinkingLevel: "medium",
			tools: responseTools(toolNames),
			systemPrompt: instructions,
		},
		streamFn: (model, context, options) =>
			models.streamSimple(model, context, options),
	});

	await agent.prompt(message);
	const assistantMessage = agent.state.messages.findLast(isAssistantMessage);

	if (assistantMessage === undefined) {
		throw new Error("expected assistant message");
	}

	return contentText(assistantMessage.content);
}
