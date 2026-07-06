import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	createApiTestContext,
	expectAgentResponseMessage,
	fileReaderTool,
	getAgentResponseMessage,
	missingAgentId,
	primaryModel,
	researchAgentInstructions,
	webSearchTool,
} from "./support/api.ts";

const { client, createAgent, testDirectory } = createApiTestContext(
	"marvin-agent-responses-",
);

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
