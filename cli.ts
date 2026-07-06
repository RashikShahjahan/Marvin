#!/usr/bin/env bun

type CliFetcher = (url: string, init?: RequestInit) => Promise<Response>;

type CliOptions = {
	apiUrl: string;
	fetch: CliFetcher;
	write: (line: string) => void;
};

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

type ParsedFlags = {
	values: Map<string, string>;
	repeatedValues: Map<string, string[]>;
};

export async function runCli(
	args: string[],
	options: CliOptions,
): Promise<void> {
	const resource = args[0];
	const action = args[1];

	if (resource === undefined || action === undefined) {
		throw new Error("usage: marvin <agents|responses> <command>");
	}

	if (resource === "agents") {
		await runAgentsCommand(action, args.slice(2), options);
		return;
	}

	if (resource === "responses") {
		await runResponsesCommand(action, args.slice(2), options);
		return;
	}

	throw new Error(`unknown resource: ${resource}`);
}

async function runAgentsCommand(
	action: string,
	args: string[],
	options: CliOptions,
): Promise<void> {
	if (action === "list") {
		await request("/agents", "GET", undefined, options);
		return;
	}

	if (action === "get") {
		const id = requiredArgument(args, 0, "agent id");
		await request(`/agents/${id}`, "GET", undefined, options);
		return;
	}

	if (action === "create") {
		const flags = parseFlags(args);
		await request("/agents", "POST", createAgentBody(flags), options);
		return;
	}

	if (action === "update") {
		const id = requiredArgument(args, 0, "agent id");
		const flags = parseFlags(args.slice(1));
		await request(`/agents/${id}`, "PATCH", updateAgentBody(flags), options);
		return;
	}

	if (action === "delete") {
		const id = requiredArgument(args, 0, "agent id");
		await request(`/agents/${id}`, "DELETE", undefined, options);
		return;
	}

	throw new Error(`unknown agents command: ${action}`);
}

async function runResponsesCommand(
	action: string,
	args: string[],
	options: CliOptions,
): Promise<void> {
	if (action === "create") {
		const flags = parseFlags(args);
		await request(
			"/agent/responses",
			"POST",
			createResponseBody(flags),
			options,
		);
		return;
	}

	throw new Error(`unknown responses command: ${action}`);
}

function createAgentBody(flags: ParsedFlags) {
	const description = optionalFlag(flags, "description");
	const tools = repeatedFlag(flags, "tool");

	return {
		name: requiredFlag(flags, "name"),
		...(description !== undefined ? { description } : {}),
		instructions: requiredFlag(flags, "instructions"),
		model: requiredFlag(flags, "model"),
		...(tools !== undefined ? { tools } : {}),
	};
}

function updateAgentBody(flags: ParsedFlags) {
	const name = optionalFlag(flags, "name");
	const description = optionalFlag(flags, "description");
	const instructions = optionalFlag(flags, "instructions");
	const model = optionalFlag(flags, "model");
	const tools = repeatedFlag(flags, "tool");

	return {
		...(name !== undefined ? { name } : {}),
		...(description !== undefined ? { description } : {}),
		...(instructions !== undefined ? { instructions } : {}),
		...(model !== undefined ? { model } : {}),
		...(tools !== undefined ? { tools } : {}),
	};
}

function createResponseBody(flags: ParsedFlags) {
	const conversationId = optionalFlag(flags, "conversation-id");

	return {
		agent_id: requiredFlag(flags, "agent-id"),
		...(conversationId !== undefined
			? { conversation_id: conversationId }
			: {}),
		message: requiredFlag(flags, "message"),
	};
}

function parseFlags(args: string[]): ParsedFlags {
	const values = new Map<string, string>();
	const repeatedValues = new Map<string, string[]>();

	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];

		if (name === undefined || !name.startsWith("--")) {
			throw new Error("expected a flag beginning with --");
		}

		if (value === undefined || value.startsWith("--")) {
			throw new Error(`expected a value for ${name}`);
		}

		const key = name.slice(2);
		const existing = repeatedValues.get(key);
		values.set(key, value);
		repeatedValues.set(
			key,
			existing === undefined ? [value] : [...existing, value],
		);
	}

	return { values, repeatedValues };
}

function requiredArgument(
	args: string[],
	index: number,
	label: string,
): string {
	const value = args[index];

	if (value === undefined) {
		throw new Error(`missing ${label}`);
	}

	return value;
}

function requiredFlag(flags: ParsedFlags, key: string): string {
	const value = flags.values.get(key);

	if (value === undefined) {
		throw new Error(`missing --${key}`);
	}

	return value;
}

function optionalFlag(flags: ParsedFlags, key: string): string | undefined {
	return flags.values.get(key);
}

function repeatedFlag(flags: ParsedFlags, key: string): string[] | undefined {
	return flags.repeatedValues.get(key);
}

async function request(
	path: string,
	method: HttpMethod,
	body: object | undefined,
	options: CliOptions,
): Promise<void> {
	const init: RequestInit = { method };

	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}

	const response = await options.fetch(endpoint(options.apiUrl, path), init);
	await writeResponse(response, options.write);
}

async function writeResponse(
	response: Response,
	write: (line: string) => void,
): Promise<void> {
	const text = await response.text();
	const output =
		text.length === 0 ? { status: response.status } : parseJson(text);

	write(JSON.stringify(output, null, 2));
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function endpoint(apiUrl: string, path: string): string {
	const base = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
	const relativePath = path.startsWith("/") ? path.slice(1) : path;

	return new URL(relativePath, base).toString();
}

function requiredEnvironmentVariable(name: string): string {
	const value = process.env[name];

	if (value === undefined) {
		throw new Error(`${name} is required`);
	}

	return value;
}

if (import.meta.main) {
	await runCli(Bun.argv.slice(2), {
		apiUrl: requiredEnvironmentVariable("MARVIN_API_URL"),
		fetch,
		write: console.log,
	});
}
