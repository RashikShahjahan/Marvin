import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

type CountRow = {
	value: number;
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

function getDatabaseAgentCount(): number {
	const row = sqlite
		.query<CountRow, []>("SELECT count(*) AS value FROM agents")
		.get();

	if (row === null) {
		throw new Error("agents table count query returned no rows");
	}

	return row.value;
}

function expectAgentResponseMessage(data: unknown): void {
	if (!isObject(data)) {
		throw new Error("expected response body object");
	}

	expect(Object.keys(data)).toHaveLength(1);
	if (typeof data.message !== "string") {
		throw new Error("expected response message string");
	}
	expect(data.message.length).toBeGreaterThan(0);
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

	test("9. Create Agent - disallowed metadata field", async () => {
		const response = await client.post("/agents", {
			name: "Metadata Agent",
			instructions: "You are a helpful assistant.",
			model: primaryModel,
			metadata: {
				team: "support",
			},
		});

		expect(response.status).toBe(400);
	});

	test("10. Create Agent - disallowed status field", async () => {
		const initialAgentCount = getDatabaseAgentCount();
		const response = await client.post("/agents", {
			name: "Status Agent",
			instructions: "You are a helpful assistant.",
			model: primaryModel,
			status: "active",
		});

		expect(response.status).toBe(400);
		expect(getDatabaseAgentCount()).toBe(initialAgentCount);
	});
});

describe("PATCH /agents/:id", () => {
	test("11. Update Agent - name only", async () => {
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

	test("12. Update Agent - description only", async () => {
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

	test("13. Update Agent - clear description", async () => {
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

	test("14. Update Agent - instructions only", async () => {
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

	test("15. Update Agent - model only", async () => {
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

	test("16. Update Agent - tools only", async () => {
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

	test("17. Update Agent - full update", async () => {
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

	test("18. Update Agent - empty body", async () => {
		const agentId = await createAgent({
			name: supportAgentName,
			instructions: supportAgentInstructions,
			model: primaryModel,
		});
		const response = await client.patch(`/agents/${agentId}`, {});

		expect(response.status).toBe(400);
	});

	test("19. Update Agent - empty name", async () => {
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

	test("20. Update Agent - empty instructions", async () => {
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

	test("21. Update Agent - custom model", async () => {
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

	test("22. Update Agent - disallowed metadata field", async () => {
		const agentId = await createAgent({
			name: "Technical Support Agent",
			description: "Answers technical support questions.",
			instructions: "You help users troubleshoot technical issues.",
			model: customModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.patch(`/agents/${agentId}`, {
			metadata: {
				team: "support",
			},
		});

		expect(response.status).toBe(400);
		expectDatabaseAgent(agentId, {
			name: "Technical Support Agent",
			description: "Answers technical support questions.",
			instructions: "You help users troubleshoot technical issues.",
			model: customModel,
			tools: JSON.stringify([webSearchTool, fileReaderTool]),
		});
	});

	test("23. Update Agent - disallowed status field", async () => {
		const agentId = await createAgent({
			name: "Technical Support Agent",
			description: "Answers technical support questions.",
			instructions: "You help users troubleshoot technical issues.",
			model: customModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.patch(`/agents/${agentId}`, {
			status: "inactive",
		});

		expect(response.status).toBe(400);
		expectDatabaseAgent(agentId, {
			name: "Technical Support Agent",
			description: "Answers technical support questions.",
			instructions: "You help users troubleshoot technical issues.",
			model: customModel,
			tools: JSON.stringify([webSearchTool, fileReaderTool]),
		});
	});
});

describe("DELETE /agents/:id", () => {
	test("24. Delete Agent - existing agent", async () => {
		const agentId = await createAgent({
			name: "Delete Agent",
			instructions: "You are deleted during the test.",
			model: primaryModel,
		});
		const response = await client.delete(`/agents/${agentId}`);

		expect(response.status).toBe(204);
	});

	test("25. Delete Agent - already deleted agent", async () => {
		const agentId = await createAgent({
			name: "Delete Twice Agent",
			instructions: "You are deleted twice during the test.",
			model: primaryModel,
		});
		const firstResponse = await client.delete(`/agents/${agentId}`);
		const secondResponse = await client.delete(`/agents/${agentId}`);

		expect(firstResponse.status).toBe(204);
		expect(secondResponse.status).toBe(204);
	});

	test("26. Delete Agent - nonexistent agent", async () => {
		const response = await client.delete(`/agents/${missingAgentId}`);

		expect(response.status).toBe(404);
	});
});

describe("GET /agents/:id", () => {
	test("27. Get Agent - existing agent", async () => {
		const agentId = await createAgent({
			name: "Get Agent",
			instructions: "You are fetched during the test.",
			model: primaryModel,
		});
		const response = await client.get(`/agents/${agentId}`);

		expect(response.status).toBe(200);
	});

	test("28. Get Agent - nonexistent agent", async () => {
		const response = await client.get(`/agents/${missingAgentId}`);

		expect(response.status).toBe(404);
	});

	test("29. Get Agent - deleted agent", async () => {
		const agentId = await createAgent({
			name: "Deleted Get Agent",
			instructions: "You are deleted before fetch.",
			model: primaryModel,
		});
		const deleteResponse = await client.delete(`/agents/${agentId}`);
		const getResponse = await client.get(`/agents/${agentId}`);

		expect(deleteResponse.status).toBe(204);
		expect(getResponse.status).toBe(404);
	});
});

describe("GET /agents", () => {
	test("30. List Agents", async () => {
		const response = await client.get("/agents");

		expect(response.status).toBe(200);
	});

	test("31. List Agents with pagination", async () => {
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
	test("32. Create Agent Response - valid request", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: "Reply with one short sentence about your capabilities.",
		});

		expect(response.status).toBe(200);
		expectAgentResponseMessage(response.data);
	}, 60000);

	test("33. Create Agent Response - disallowed model override", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			model: customModel,
			message: "Use the default model for this response.",
		});

		expect(response.status).toBe(400);
	});

	test("34. Create Agent Response - missing agent_id", async () => {
		const response = await client.post("/agent/responses", {
			message: "What can you help me with?",
		});

		expect(response.status).toBe(400);
	});

	test("35. Create Agent Response - missing message", async () => {
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

	test("36. Create Agent Response - empty message", async () => {
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

	test("37. Create Agent Response - empty model", async () => {
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

	test("38. Create Agent Response - disallowed role field", async () => {
		const agentId = await createAgent({
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: researchAgentInstructions,
			model: primaryModel,
			tools: [webSearchTool, fileReaderTool],
		});
		const response = await client.post("/agent/responses", {
			agent_id: agentId,
			message: "What can you help me with?",
			role: "assistant",
		});

		expect(response.status).toBe(400);
	});

	test("39. Create Agent Response - nonexistent agent", async () => {
		const response = await client.post("/agent/responses", {
			agent_id: missingAgentId,
			message: "What can you help me with?",
		});

		expect(response.status).toBe(404);
	});
});
