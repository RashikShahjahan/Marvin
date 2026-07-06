import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import axios from "axios";

const defaultApiProtocol = "http";
const defaultApiHost = "localhost";
const defaultApiPort = "3000";
const defaultApiBaseUrl = `${defaultApiProtocol}://${defaultApiHost}:${defaultApiPort}`;

const testDirectory = mkdtempSync(join(tmpdir(), "marvin-tests-"));
const databasePath = join(testDirectory, "agents.sqlite");

const client = axios.create({
	baseURL: defaultApiBaseUrl,
	validateStatus: () => true,
});

const primaryModel = "gpt-4.1";
const miniModel = "gpt-4.1-mini";
const customModel = "custom-reasoning-model";
const customTool = "custom_search";
const supportAgentName = "Support Agent";
const supportAgentInstructions = "You are a helpful customer support agent.";
const researchAgentInstructions =
	"You research topics and provide concise summaries.";
const webSearchTool = "web_search";
const fileReaderTool = "file_reader";
const missingAgentId = "ag_missing";

let serverProcess: ReturnType<typeof Bun.spawn>;
let sqlite: Database;

type CreateAgentRequest = {
	name: string;
	description?: string;
	instructions: string;
	model: string;
	tools?: string[];
};

type ExpectedAgentRow = {
	name: string;
	description: string | null;
	instructions: string;
	model: string;
	tools: string | null;
};

type AgentRow = ExpectedAgentRow & {
	id: string;
};

beforeAll(async () => {
	mkdirSync(testDirectory, { recursive: true });

	serverProcess = Bun.spawn(["bun", "index.ts"], {
		cwd: import.meta.dir,
		env: {
			...process.env,
			AGENTS_DB_PATH: databasePath,
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	await Bun.sleep(500);
	sqlite = new Database(databasePath, {
		readonly: true,
		create: false,
	});
});

afterAll(() => {
	sqlite.close();
	serverProcess.kill();
	rmSync(testDirectory, { recursive: true, force: true });
});

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAgentId(data: unknown): string {
	if (!isObject(data) || typeof data.id !== "string") {
		throw new Error("expected response body to include string id");
	}

	return data.id;
}

async function createAgent(request: CreateAgentRequest): Promise<string> {
	const response = await client.post("/agents", request);
	expect(response.status).toBe(201);
	return getAgentId(response.data);
}

function expectDatabaseAgent(
	agentId: string,
	expected: ExpectedAgentRow,
): void {
	const row = sqlite
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
}

function getAgentResponseMessage(data: unknown): string {
	if (!isObject(data)) {
		throw new Error("expected response body object");
	}

	expect(Object.keys(data)).toHaveLength(1);
	if (typeof data.message !== "string") {
		throw new Error("expected response message string");
	}

	return data.message;
}

function expectAgentResponseMessage(data: unknown): void {
	expect(getAgentResponseMessage(data).length).toBeGreaterThan(0);
}

describe("POST /agents", () => {
	test("1. Create Agent - valid minimal request", async () => {
		const response = await client.post("/agents", {
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});

		expect(response.status).toBe(201);
		const agentId = getAgentId(response.data);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: null,
			instructions: supportAgentInstructions,
			model: primaryModel,
			tools: null,
		});
	});

	test("2. Create Agent - valid full request", async () => {
		const response = await client.post("/agents", {
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});

		expect(response.status).toBe(201);
		const agentId = getAgentId(response.data);
		expectDatabaseAgent(agentId, {
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: JSON.stringify([webSearchTool, fileReaderTool]),
		});
	});

	test("3. Create Agent - missing name", async () => {
		const response = await client.post("/agents", {
			instructions: "You are a helpful assistant.",
			model: primaryModel,
		});

		expect(response.status).toBe(400);
	});

	test("4. Create Agent - missing instructions", async () => {
		const response = await client.post("/agents", {
			name: "Broken Agent",
			model: primaryModel,
		});

		expect(response.status).toBe(400);
	});

	test("5. Create Agent - missing model", async () => {
		const response = await client.post("/agents", {
			name: "Broken Agent",
			instructions: "You are a helpful assistant.",
		});

		expect(response.status).toBe(400);
	});

	test("6. Create Agent - empty name", async () => {
		const response = await client.post("/agents", {
			name: "",
			instructions: "You are a helpful assistant.",
			model: primaryModel,
		});

		expect(response.status).toBe(400);
	});

	test("7. Create Agent - custom model", async () => {
		const response = await client.post("/agents", {
			name: "Custom Model Agent",
			instructions: "You are a helpful assistant.",
			model: customModel,
		});

		expect(response.status).toBe(201);
		const agentId = getAgentId(response.data);
		expectDatabaseAgent(agentId, {
			name: "Custom Model Agent",
			description: null,
			instructions: "You are a helpful assistant.",
			model: customModel,
			tools: null,
		});
	});

	test("8. Create Agent - custom tools", async () => {
		const response = await client.post("/agents", {
			name: "Tool Agent",
			instructions: "You use tools when needed.",
			model: primaryModel,
			tools: [customTool],
		});

		expect(response.status).toBe(201);
		const agentId = getAgentId(response.data);
		expectDatabaseAgent(agentId, {
			name: "Tool Agent",
			description: null,
			instructions: "You use tools when needed.",
			model: primaryModel,
			tools: JSON.stringify([customTool]),
		});
	});
});

describe("PATCH /agents/:id", () => {
	test("9. Update Agent - name only", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			name: "Updated Support Agent",
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: "Updated Support Agent",
			description: null,
			instructions: supportAgentInstructions,
			model: primaryModel,
			tools: null,
		});
	});

	test("10. Update Agent - description only", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			description: "Handles customer support conversations.",
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: "Handles customer support conversations.",
			instructions: supportAgentInstructions,
			model: primaryModel,
			tools: null,
		});
	});

	test("11. Update Agent - clear description", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			description: "Handles customer support conversations.",
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			description: null,
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: null,
			instructions: supportAgentInstructions,
			model: primaryModel,
			tools: null,
		});
	});

	test("12. Update Agent - instructions only", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			instructions: "You are a concise and professional support agent.",
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: null,
			instructions: "You are a concise and professional support agent.",
			model: primaryModel,
			tools: null,
		});
	});

	test("13. Update Agent - model only", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: "You are a concise and professional support agent.",
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			model: miniModel,
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: null,
			instructions: "You are a concise and professional support agent.",
			model: miniModel,
			tools: null,
		});
	});

	test("14. Update Agent - tools only", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: "You are a concise and professional support agent.",
			model: miniModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			tools: [webSearchTool],
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: null,
			instructions: "You are a concise and professional support agent.",
			model: miniModel,
			tools: JSON.stringify([webSearchTool]),
		});
	});

	test("15. Update Agent - full update", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: "You are a concise and professional support agent.",
			model: miniModel,
			tools: [webSearchTool],
		});
		const response = await client.patch(`/agents/${agentId}`, {
			name: "Technical Support Agent",
			description: "Answers technical support questions.",
			instructions: "You help users troubleshoot technical issues.",
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: "Technical Support Agent",
			description: "Answers technical support questions.",
			instructions: "You help users troubleshoot technical issues.",
			model: primaryModel,
			tools: JSON.stringify([webSearchTool, fileReaderTool]),
		});
	});

	test("16. Update Agent - empty body", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {});

		expect(response.status).toBe(400);
	});

	test("17. Update Agent - empty name", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			name: "",
		});

		expect(response.status).toBe(400);
	});

	test("18. Update Agent - empty instructions", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			instructions: "",
		});

		expect(response.status).toBe(400);
	});

	test("19. Update Agent - custom model", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {
			model: customModel,
		});

		expect(response.status).toBe(200);
		expectDatabaseAgent(agentId, {
			name: supportAgentName,
			description: null,
			instructions: supportAgentInstructions,
			model: customModel,
			tools: null,
		});
	});
});

describe("DELETE /agents/:id", () => {
	test("20. Delete Agent - existing agent", async () => {
		const agentId = await createAgent({
			name: "Delete Agent",
			instructions: "You are deleted during the test.",
			model: primaryModel,
		});
		const response = await client.delete(`/agents/${agentId}`);

		expect(response.status).toBe(204);
	});

	test("21. Delete Agent - nonexistent agent", async () => {
		const response = await client.delete(`/agents/${missingAgentId}`);

		expect(response.status).toBe(404);
	});
});

describe("GET /agents/:id", () => {
	test("22. Get Agent - existing agent", async () => {
		const agentId = await createAgent({
			name: "Get Agent",
			instructions: "You are fetched during the test.",
			model: primaryModel,
		});
		const response = await client.get(`/agents/${agentId}`);

		expect(response.status).toBe(200);
	});

	test("23. Get Agent - nonexistent agent", async () => {
		const response = await client.get(`/agents/${missingAgentId}`);

		expect(response.status).toBe(404);
	});
});

describe("GET /agents", () => {
	test("24. List Agents", async () => {
		const response = await client.get("/agents");

		expect(response.status).toBe(200);
	});

	test("25. List Agents with pagination", async () => {
		const response = await client.get("/agents", {
			params: {
				limit: 20,
				cursor: "next_cursor_value",
			},
		});

		expect(response.status).toBe(200);
	});
});

describe("POST /agent/responses", () => {
	test("26. Create Agent Response - valid request", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: "Reply with one short sentence about your capabilities.",
		});

		expect(response.status).toBe(200);
		expectAgentResponseMessage(response.data);
	}, 60000);

	test("27. Create Agent Response - read tool", async () => {
		const filePath = join(testDirectory, "read-tool.txt");
		const fileContent = "READ_TOOL_SENTINEL_27";
		writeFileSync(filePath, fileContent);
		const agentId = await createAgent({
			name: "Read Tool Agent",
			instructions:
				"Use the read tool when asked to read a file. After reading, reply only with the file contents.",
			model: primaryModel,
			tools: ["read"],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: `Read ${filePath} with the read tool.`,
		});

		expect(response.status).toBe(200);
		expect(getAgentResponseMessage(response.data)).toContain(fileContent);
	}, 60000);

	test("28. Create Agent Response - write tool", async () => {
		const filePath = join(testDirectory, "write-tool.txt");
		const fileContent = "WRITE_TOOL_SENTINEL_28";
		const agentId = await createAgent({
			name: "Write Tool Agent",
			instructions:
				"Use the write tool when asked to write a file. After writing, reply only with TOOL_DONE.",
			model: primaryModel,
			tools: ["write"],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: `Use the write tool with path ${filePath} and content ${fileContent}.`,
		});

		expect(response.status).toBe(200);
		expectAgentResponseMessage(response.data);
		expect(readFileSync(filePath, "utf-8")).toBe(fileContent);
	}, 60000);

	test("29. Create Agent Response - edit tool", async () => {
		const filePath = join(testDirectory, "edit-tool.txt");
		writeFileSync(filePath, "before EDIT_TOOL_BEFORE_29 after");
		const agentId = await createAgent({
			name: "Edit Tool Agent",
			instructions:
				"Use the edit tool when asked to edit a file. After editing, reply only with TOOL_DONE.",
			model: primaryModel,
			tools: ["edit"],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: `Use the edit tool on ${filePath}. Replace oldText EDIT_TOOL_BEFORE_29 with newText EDIT_TOOL_AFTER_29.`,
		});

		expect(response.status).toBe(200);
		expectAgentResponseMessage(response.data);
		expect(readFileSync(filePath, "utf-8")).toBe(
			"before EDIT_TOOL_AFTER_29 after",
		);
	}, 60000);

	test("30. Create Agent Response - bash tool", async () => {
		const filePath = join(testDirectory, "bash-tool.txt");
		const fileContent = "BASH_TOOL_SENTINEL_30";
		const agentId = await createAgent({
			name: "Bash Tool Agent",
			instructions:
				"Use the bash tool when asked to run a command. After the command succeeds, reply only with TOOL_DONE.",
			model: primaryModel,
			tools: ["bash"],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: `Use the bash tool to run: printf ${fileContent} > ${filePath}`,
		});

		expect(response.status).toBe(200);
		expectAgentResponseMessage(response.data);
		expect(readFileSync(filePath, "utf-8")).toBe(fileContent);
	}, 60000);

	test("31. Create Agent Response - missing agent_id", async () => {
		const response = await client.post("/agent/responses", {
			message: "What can you help me with?",
		});

		expect(response.status).toBe(400);
	});

	test("32. Create Agent Response - missing message", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
		});

		expect(response.status).toBe(400);
	});

	test("33. Create Agent Response - empty message", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: "",
		});

		expect(response.status).toBe(400);
	});

	test("34. Create Agent Response - empty model", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			model: "",
			message: "What can you help me with?",
		});

		expect(response.status).toBe(400);
	});

	test("35. Create Agent Response - nonexistent agent", async () => {
		const response = await client.post("/agent/responses", {
			agent_id: missingAgentId,
			message: "What can you help me with?",
		});

		expect(response.status).toBe(404);
	});
});
