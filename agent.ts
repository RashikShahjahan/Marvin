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

const textContentSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
		textSignature: z.string().optional(),
	})
	.strict();
const imageContentSchema = z
	.object({
		type: z.literal("image"),
		data: z.string(),
		mimeType: z.string(),
	})
	.strict();
const thinkingContentSchema = z
	.object({
		type: z.literal("thinking"),
		thinking: z.string(),
		thinkingSignature: z.string().optional(),
		redacted: z.boolean().optional(),
	})
	.strict();
const toolCallSchema = z
	.object({
		type: z.literal("toolCall"),
		id: z.string(),
		name: z.string(),
		arguments: z.record(z.string(), z.unknown()),
		thoughtSignature: z.string().optional(),
	})
	.strict();
const diagnosticErrorInfoSchema = z
	.object({
		name: z.string().optional(),
		message: z.string(),
		stack: z.string().optional(),
		code: z.union([z.string(), z.number()]).optional(),
	})
	.strict();
const diagnosticSchema = z
	.object({
		type: z.string(),
		timestamp: z.number(),
		error: diagnosticErrorInfoSchema.optional(),
		details: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
const usageSchema = z
	.object({
		input: z.number(),
		output: z.number(),
		cacheRead: z.number(),
		cacheWrite: z.number(),
		cacheWrite1h: z.number().optional(),
		reasoning: z.number().optional(),
		totalTokens: z.number(),
		cost: z
			.object({
				input: z.number(),
				output: z.number(),
				cacheRead: z.number(),
				cacheWrite: z.number(),
				total: z.number(),
			})
			.strict(),
	})
	.strict();
const userMessageSchema = z
	.object({
		role: z.literal("user"),
		content: z.union([
			z.string(),
			z.array(z.union([textContentSchema, imageContentSchema])),
		]),
		timestamp: z.number(),
	})
	.strict();
const assistantMessageSchema = z
	.object({
		role: z.literal("assistant"),
		content: z.array(
			z.union([textContentSchema, thinkingContentSchema, toolCallSchema]),
		),
		api: z.string(),
		provider: z.string(),
		model: z.string(),
		responseModel: z.string().optional(),
		responseId: z.string().optional(),
		diagnostics: z.array(diagnosticSchema).optional(),
		usage: usageSchema,
		stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
		errorMessage: z.string().optional(),
		timestamp: z.number(),
	})
	.strict();
const toolResultMessageSchema = z
	.object({
		role: z.literal("toolResult"),
		toolCallId: z.string(),
		toolName: z.string(),
		content: z.array(z.union([textContentSchema, imageContentSchema])),
		details: z.unknown().optional(),
		isError: z.boolean(),
		timestamp: z.number(),
	})
	.strict();
const agentMessageSchema = z.union([
	userMessageSchema,
	assistantMessageSchema,
	toolResultMessageSchema,
]);
const agentMessagesSchema = z.array(agentMessageSchema);

export function parseAgentMessages(
	messages: string,
): AgentMessage[] | undefined {
	let parsedMessages: unknown;

	try {
		parsedMessages = JSON.parse(messages);
	} catch {
		return undefined;
	}

	const parseResult = agentMessagesSchema.safeParse(parsedMessages);

	if (!parseResult.success) {
		return undefined;
	}

	return parseResult.data;
}

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

export type AgentResponseResult = {
	message: string;
	messages: AgentMessage[];
};

export async function createAgentResponse(
	instructions: string,
	message: string,
	toolNames: string[],
	messages: AgentMessage[],
): Promise<AgentResponseResult> {
	const agent = new Agent({
		initialState: {
			model: defaultModel,
			thinkingLevel: "medium",
			tools: responseTools(toolNames),
			systemPrompt: instructions,
			messages,
		},
		streamFn: (model, context, options) =>
			models.streamSimple(model, context, options),
	});

	await agent.prompt(message);
	const assistantMessage = agent.state.messages.findLast(isAssistantMessage);

	if (assistantMessage === undefined) {
		throw new Error("expected assistant message");
	}

	return {
		message: contentText(assistantMessage.content),
		messages: agent.state.messages,
	};
}
