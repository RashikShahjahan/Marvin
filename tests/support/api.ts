import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect } from "bun:test";
import axios, { type AxiosInstance } from "axios";

const defaultApiProtocol = "http";
const defaultApiHost = "localhost";

const projectRoot = join(import.meta.dir, "../..");
let nextApiPort = 3100;

export const primaryModel = "gpt-4.1";
export const miniModel = "gpt-4.1-mini";
export const customModel = "custom-reasoning-model";
export const customTool = "custom_search";
export const supportAgentName = "Support Agent";
export const supportAgentInstructions =
	"You are a helpful customer support agent.";
export const researchAgentInstructions =
	"You research topics and provide concise summaries.";
export const webSearchTool = "web_search";
export const fileReaderTool = "file_reader";
export const missingAgentId = "ag_missing";

export type CreateAgentRequest = {
	name: string;
	description?: string;
	instructions: string;
	model: string;
	tools?: string[];
};

export type ExpectedAgentRow = {
	name: string;
	description: string | null;
	instructions: string;
	model: string;
	tools: string | null;
};

type AgentRow = ExpectedAgentRow & {
	id: string;
};

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAgentId(data: unknown): string {
	if (!isObject(data) || typeof data.id !== "string") {
		throw new Error("expected response body to include string id");
	}

	return data.id;
}

export function getAgentResponseMessage(data: unknown): string {
	if (!isObject(data)) {
		throw new Error("expected response body object");
	}

	if (typeof data.message !== "string") {
		throw new Error("expected response message string");
	}

	return data.message;
}

export function expectAgentResponseMessage(data: unknown): void {
	expect(getAgentResponseMessage(data).length).toBeGreaterThan(0);
}

type TestDatabase = {
	testDirectory: string;
	databasePath: string;
};

function createTestDatabase(testDirectoryPrefix: string): TestDatabase {
	const testDirectory = mkdtempSync(join(tmpdir(), testDirectoryPrefix));

	return {
		testDirectory,
		databasePath: join(testDirectory, "agents.sqlite"),
	};
}

function createApiPort(): string {
	nextApiPort += 1;
	return `${nextApiPort}`;
}

function createApiBaseUrl(apiPort: string): string {
	return `${defaultApiProtocol}://${defaultApiHost}:${apiPort}`;
}

function createApiClient(apiPort: string): AxiosInstance {
	return axios.create({
		baseURL: createApiBaseUrl(apiPort),
		validateStatus: () => true,
	});
}

function startApiServer(
	databasePath: string,
	apiPort: string,
): Bun.ReadableSubprocess {
	return Bun.spawn(["bun", "index.ts"], {
		cwd: projectRoot,
		env: {
			...process.env,
			AGENTS_DB_PATH: databasePath,
			PORT: apiPort,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

function openTestDatabase(databasePath: string): Database {
	return new Database(databasePath, {
		readonly: true,
		create: false,
	});
}

function createAgentFactory(client: AxiosInstance) {
	return async function createAgent(
		request: CreateAgentRequest,
	): Promise<string> {
		const response = await client.post("/agents", request);
		expect(response.status).toBe(201);
		return getAgentId(response.data);
	};
}

function createDatabaseAgentExpectation(getSqlite: () => Database) {
	return function expectDatabaseAgent(
		agentId: string,
		expected: ExpectedAgentRow,
	): void {
		const row = getSqlite()
			.query<AgentRow, [string]>(
				`SELECT id, name, description, instructions, model, tools
				FROM agents
				WHERE id = ?`,
			)
			.get(agentId);

		if (row === null) {
			throw new Error("expected database agent row");
		}

		expect(row.id).toBe(agentId);
		expect(row.name).toBe(expected.name);
		expect(row.description).toBe(expected.description);
		expect(row.instructions).toBe(expected.instructions);
		expect(row.model).toBe(expected.model);
		expect(row.tools).toBe(expected.tools);
	};
}

export function createApiTestContext(testDirectoryPrefix: string) {
	const { databasePath, testDirectory } =
		createTestDatabase(testDirectoryPrefix);
	const apiPort = createApiPort();
	const client = createApiClient(apiPort);
	const outputDecoder = new TextDecoder();
	let serverOutput = "";

	let serverProcess: Bun.ReadableSubprocess;
	let serverOutputIterator: AsyncIterator<Uint8Array<ArrayBuffer>>;
	let sqlite: Database;

	beforeAll(async () => {
		mkdirSync(testDirectory, { recursive: true });
		serverProcess = startApiServer(databasePath, apiPort);
		serverOutputIterator = serverProcess.stdout[Symbol.asyncIterator]();
		await Bun.sleep(500);
		sqlite = openTestDatabase(databasePath);
	});

	afterAll(() => {
		sqlite.close();
		serverProcess.kill();
		rmSync(testDirectory, { recursive: true, force: true });
	});

	async function readServerOutputUntil(text: string): Promise<string> {
		while (!serverOutput.includes(text)) {
			const readResult = await serverOutputIterator.next();

			if (readResult.done) {
				throw new Error("expected server output");
			}

			serverOutput += outputDecoder.decode(readResult.value, { stream: true });
		}

		return serverOutput;
	}

	return {
		client,
		createAgent: createAgentFactory(client),
		expectDatabaseAgent: createDatabaseAgentExpectation(() => sqlite),
		readServerOutputUntil,
		testDirectory,
	};
}
