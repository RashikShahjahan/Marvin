import { Database } from "bun:sqlite";
import axios, { type AxiosResponse } from "axios";
import { count, eq } from "drizzle-orm";
// pi-lens-ignore: ast-grep:find-import-file-without-extension
import { drizzle } from "drizzle-orm/bun-sqlite";
// pi-lens-ignore: ast-grep:find-import-file-without-extension
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const defaultApiProtocol = "http";
const defaultApiHost = "localhost";
const defaultApiPort = "3000";
const defaultApiBaseUrl = `${defaultApiProtocol}://${defaultApiHost}:${defaultApiPort}`;

const client = axios.create({
	baseURL: process.env.AGENTS_API_BASE_URL ?? defaultApiBaseUrl,
	validateStatus: () => true,
});

const primaryModel = "gpt-4.1";
const miniModel = "gpt-4.1-mini";

const agentsTable = sqliteTable("agents", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	instructions: text("instructions").notNull(),
	model: text("model").notNull(),
	tools: text("tools"),
});

type ExpectedAgentRow = {
	name: string;
	description: string | null;
	instructions: string;
	model: string;
	tools: string | null;
};

const databasePath = process.env.AGENTS_DB_PATH ?? "agents.sqlite";

const sqlite = new Database(databasePath, {
	readonly: true,
	create: false,
});
const database = drizzle({ client: sqlite });
const initialAgentCountRow = database
	.select({ value: count() })
	.from(agentsTable)
	.get();

if (initialAgentCountRow === undefined) {
	throw new Error("agents table count query returned no rows");
}

const initialAgentCount = initialAgentCountRow.value;

type TestResponse = AxiosResponse<unknown> | undefined;

async function expectStatus(
	label: string,
	expectedStatus: number,
	request: Promise<AxiosResponse<unknown>>,
): Promise<TestResponse> {
	try {
		const response = await request;
		const passed = response.status === expectedStatus;
		const result = passed ? "PASS" : "FAIL";

		process.stdout.write(
			`${result} ${label} expected ${expectedStatus} got ${response.status}\n`,
		);

		if (!passed) {
			process.stdout.write(`${JSON.stringify(response.data)}\n`);
			process.exitCode = 1;
		}

		return response;
	} catch (error: unknown) {
		process.stdout.write(
			`${"FAIL"} ${label} expected ${expectedStatus} request failed\n`,
		);

		if (axios.isAxiosError(error)) {
			process.stdout.write(`${error.message}\n`);
		}

		process.exitCode = 1;
		return undefined;
	}
}

function expectStatusForAgent(
	label: string,
	expectedStatus: number,
	agentId: string | undefined,
	request: (id: string) => Promise<AxiosResponse<unknown>>,
): Promise<TestResponse> {
	if (agentId === undefined) {
		process.stdout.write(
			`${"SKIP"} ${label} missing agent id from create response\n`,
		);
		process.exitCode = 1;
		return Promise.resolve(undefined);
	}

	return expectStatus(label, expectedStatus, request(agentId));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAgentId(label: string, data: unknown): string | undefined {
	if (isObject(data) && typeof data.id === "string") {
		return data.id;
	}

	process.stdout.write(
		`FAIL ${label} expected response body to include string id\n`,
	);
	process.exitCode = 1;
	return undefined;
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
	const passed = actual === expected;
	const result = passed ? "PASS" : "FAIL";

	process.stdout.write(
		`${result} ${label} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}\n`,
	);

	if (!passed) {
		process.exitCode = 1;
	}
}

function expectDatabaseAgent(
	label: string,
	agentId: string | undefined,
	expected: ExpectedAgentRow,
): void {
	if (agentId === undefined) {
		process.stdout.write(`${"SKIP"} ${label} missing agent id\n`);
		process.exitCode = 1;
		return;
	}

	const row = database
		.select()
		.from(agentsTable)
		.where(eq(agentsTable.id, agentId))
		.get();

	if (row === undefined) {
		process.stdout.write(`${"FAIL"} ${label} expected database agent row\n`);
		process.exitCode = 1;
		return;
	}

	expectEqual(`${label} database id`, row.id, agentId);
	expectEqual(`${label} database name`, row.name, expected.name);
	expectEqual(
		`${label} database description`,
		row.description,
		expected.description,
	);
	expectEqual(
		`${label} database instructions`,
		row.instructions,
		expected.instructions,
	);
	expectEqual(`${label} database model`, row.model, expected.model);
	expectEqual(`${label} database tools`, row.tools, expected.tools);
}

function expectDatabaseAgentCount(label: string, expectedCount: number): void {
	const row = database.select({ value: count() }).from(agentsTable).get();
	expectEqual(`${label} database agent count`, row?.value, expectedCount);
}

async function runAgentApiRequests(): Promise<void> {
	const missingAgentId = "ag_missing";

	const createMinimalResponse = await expectStatus(
		"1. Create Agent - valid minimal request",
		201,
		client.post("/agents", {
			name: "Support Agent",
			instructions: "You are a helpful customer support agent.",
			model: primaryModel,
		}),
	);
	const agentId = getAgentId(
		"1. Create Agent - valid minimal request",
		createMinimalResponse?.data,
	);
	expectDatabaseAgent("1. Create Agent - valid minimal request", agentId, {
		name: "Support Agent",
		description: null,
		instructions: "You are a helpful customer support agent.",
		model: primaryModel,
		tools: null,
	});

	const createFullResponse = await expectStatus(
		"2. Create Agent - valid full request",
		201,
		client.post("/agents", {
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: "You research topics and provide concise summaries.",
			model: primaryModel,
			tools: ["web_search", "file_reader"],
		}),
	);
	const existingAgentId = getAgentId(
		"2. Create Agent - valid full request",
		createFullResponse?.data,
	);
	expectDatabaseAgent("2. Create Agent - valid full request", existingAgentId, {
		name: "Research Agent",
		description: "Finds and summarizes technical information.",
		instructions: "You research topics and provide concise summaries.",
		model: primaryModel,
		tools: JSON.stringify(["web_search", "file_reader"]),
	});

	await expectStatus(
		"3. Create Agent - missing name",
		400,
		client.post("/agents", {
			instructions: "You are a helpful assistant.",
			model: primaryModel,
		}),
	);

	await expectStatus(
		"4. Create Agent - missing instructions",
		400,
		client.post("/agents", {
			name: "Broken Agent",
			model: primaryModel,
		}),
	);

	await expectStatus(
		"5. Create Agent - missing model",
		400,
		client.post("/agents", {
			name: "Broken Agent",
			instructions: "You are a helpful assistant.",
		}),
	);

	await expectStatus(
		"6. Create Agent - empty name",
		400,
		client.post("/agents", {
			name: "",
			instructions: "You are a helpful assistant.",
			model: primaryModel,
		}),
	);

	await expectStatus(
		"7. Create Agent - invalid model",
		400,
		client.post("/agents", {
			name: "Invalid Model Agent",
			instructions: "You are a helpful assistant.",
			model: "unknown-model",
		}),
	);

	await expectStatus(
		"8. Create Agent - invalid tools",
		400,
		client.post("/agents", {
			name: "Tool Agent",
			instructions: "You use tools when needed.",
			model: primaryModel,
			tools: ["unsupported_tool"],
		}),
	);

	await expectStatus(
		"9. Create Agent - disallowed metadata field",
		400,
		client.post("/agents", {
			name: "Metadata Agent",
			instructions: "You are a helpful assistant.",
			model: primaryModel,
			metadata: {
				team: "support",
			},
		}),
	);

	await expectStatus(
		"10. Create Agent - disallowed status field",
		400,
		client.post("/agents", {
			name: "Status Agent",
			instructions: "You are a helpful assistant.",
			model: primaryModel,
			status: "active",
		}),
	);
	expectDatabaseAgentCount(
		"10. Create Agent - invalid create requests",
		initialAgentCount + 2,
	);

	await expectStatusForAgent(
		"11. Update Agent - name only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				name: "Updated Support Agent",
			}),
	);
	expectDatabaseAgent("11. Update Agent - name only", agentId, {
		name: "Updated Support Agent",
		description: null,
		instructions: "You are a helpful customer support agent.",
		model: primaryModel,
		tools: null,
	});

	await expectStatusForAgent(
		"12. Update Agent - description only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				description: "Handles customer support conversations.",
			}),
	);
	expectDatabaseAgent("12. Update Agent - description only", agentId, {
		name: "Updated Support Agent",
		description: "Handles customer support conversations.",
		instructions: "You are a helpful customer support agent.",
		model: primaryModel,
		tools: null,
	});

	await expectStatusForAgent(
		"13. Update Agent - clear description",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				description: null,
			}),
	);
	expectDatabaseAgent("13. Update Agent - clear description", agentId, {
		name: "Updated Support Agent",
		description: null,
		instructions: "You are a helpful customer support agent.",
		model: primaryModel,
		tools: null,
	});

	await expectStatusForAgent(
		"14. Update Agent - instructions only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				instructions: "You are a concise and professional support agent.",
			}),
	);
	expectDatabaseAgent("14. Update Agent - instructions only", agentId, {
		name: "Updated Support Agent",
		description: null,
		instructions: "You are a concise and professional support agent.",
		model: primaryModel,
		tools: null,
	});

	await expectStatusForAgent(
		"15. Update Agent - model only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				model: miniModel,
			}),
	);
	expectDatabaseAgent("15. Update Agent - model only", agentId, {
		name: "Updated Support Agent",
		description: null,
		instructions: "You are a concise and professional support agent.",
		model: miniModel,
		tools: null,
	});

	await expectStatusForAgent(
		"16. Update Agent - tools only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				tools: ["web_search"],
			}),
	);
	expectDatabaseAgent("16. Update Agent - tools only", agentId, {
		name: "Updated Support Agent",
		description: null,
		instructions: "You are a concise and professional support agent.",
		model: miniModel,
		tools: JSON.stringify(["web_search"]),
	});

	await expectStatusForAgent(
		"17. Update Agent - full update",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				name: "Technical Support Agent",
				description: "Answers technical support questions.",
				instructions: "You help users troubleshoot technical issues.",
				model: primaryModel,
				tools: ["web_search", "file_reader"],
			}),
	);
	expectDatabaseAgent("17. Update Agent - full update", agentId, {
		name: "Technical Support Agent",
		description: "Answers technical support questions.",
		instructions: "You help users troubleshoot technical issues.",
		model: primaryModel,
		tools: JSON.stringify(["web_search", "file_reader"]),
	});

	await expectStatusForAgent(
		"18. Update Agent - empty body",
		400,
		agentId,
		(id) => client.patch(`/agents/${id}`, {}),
	);

	await expectStatusForAgent(
		"19. Update Agent - empty name",
		400,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				name: "",
			}),
	);

	await expectStatusForAgent(
		"20. Update Agent - empty instructions",
		400,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				instructions: "",
			}),
	);

	await expectStatusForAgent(
		"21. Update Agent - invalid model",
		400,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				model: "unknown-model",
			}),
	);

	await expectStatusForAgent(
		"22. Update Agent - disallowed metadata field",
		400,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				metadata: {
					team: "support",
				},
			}),
	);

	await expectStatusForAgent(
		"23. Update Agent - disallowed status field",
		400,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				status: "inactive",
			}),
	);
	expectDatabaseAgent("23. Update Agent - invalid update requests", agentId, {
		name: "Technical Support Agent",
		description: "Answers technical support questions.",
		instructions: "You help users troubleshoot technical issues.",
		model: primaryModel,
		tools: JSON.stringify(["web_search", "file_reader"]),
	});

	await expectStatusForAgent(
		"24. Delete Agent - existing agent",
		204,
		agentId,
		(id) => client.delete(`/agents/${id}`),
	);

	await expectStatusForAgent(
		"25. Delete Agent - already deleted agent",
		204,
		agentId,
		(id) => client.delete(`/agents/${id}`),
	);

	await expectStatus(
		"26. Delete Agent - nonexistent agent",
		404,
		client.delete(`/agents/${missingAgentId}`),
	);

	await expectStatusForAgent(
		"27. Get Agent - existing agent",
		200,
		existingAgentId,
		(id) => client.get(`/agents/${id}`),
	);

	await expectStatus(
		"28. Get Agent - nonexistent agent",
		404,
		client.get(`/agents/${missingAgentId}`),
	);

	await expectStatusForAgent(
		"29. Get Agent - deleted agent",
		404,
		agentId,
		(id) => client.get(`/agents/${id}`),
	);

	await expectStatus("30. List Agents", 200, client.get("/agents"));

	await expectStatus(
		"31. List Agents with pagination",
		200,
		client.get("/agents", {
			params: {
				limit: 20,
				cursor: "next_cursor_value",
			},
		}),
	);

	if (process.exitCode === undefined) {
		process.stdout.write("All tests passed\n");
	} else {
		process.stdout.write("Some tests failed\n");
	}
}

await runAgentApiRequests();
sqlite.close();
