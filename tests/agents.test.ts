import { describe, expect, test } from "bun:test";
import {
	createApiTestContext,
	customModel,
	customTool,
	fileReaderTool,
	getAgentId,
	missingAgentId,
	miniModel,
	primaryModel,
	researchAgentInstructions,
	supportAgentInstructions,
	supportAgentName,
	webSearchTool,
} from "./support/api.ts";

const { client, createAgent, expectDatabaseAgent, readServerOutputUntil } =
	createApiTestContext("marvin-agents-api-");

describe("API logging", () => {
	test("logs request lifecycle", async () => {
		const response = await client.get("/agents");

		expect(response.status).toBe(200);
		const serverOutput = await readServerOutputUntil(
			'"type":"api.request.finish"',
		);

		expect(serverOutput).toContain(
			'{"type":"api.request.start","method":"GET","path":"/agents"}',
		);
		expect(serverOutput).toContain('"method":"GET"');
		expect(serverOutput).toContain('"path":"/agents"');
		expect(serverOutput).toContain('"status":200');
		expect(serverOutput).toContain('"duration_ms":');
	});
});

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
