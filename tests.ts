import axios, { type AxiosResponse } from "axios";

const client = axios.create({
	baseURL: process.env.AGENTS_API_BASE_URL,
	validateStatus: () => true,
});

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

async function runAgentApiRequests(): Promise<void> {
	const missingAgentId = "ag_missing";

	const createMinimalResponse = await expectStatus(
		"1. Create Agent - valid minimal request",
		201,
		client.post("/agents", {
			name: "Support Agent",
			instructions: "You are a helpful customer support agent.",
			model: "gpt-4.1",
		}),
	);
	const agentId = getAgentId(
		"1. Create Agent - valid minimal request",
		createMinimalResponse?.data,
	);

	const createFullResponse = await expectStatus(
		"2. Create Agent - valid full request",
		201,
		client.post("/agents", {
			name: "Research Agent",
			description: "Finds and summarizes technical information.",
			instructions: "You research topics and provide concise summaries.",
			model: "gpt-4.1",
			tools: ["web_search", "file_reader"],
		}),
	);
	const existingAgentId = getAgentId(
		"2. Create Agent - valid full request",
		createFullResponse?.data,
	);

	await expectStatus(
		"3. Create Agent - missing name",
		400,
		client.post("/agents", {
			instructions: "You are a helpful assistant.",
			model: "gpt-4.1",
		}),
	);

	await expectStatus(
		"4. Create Agent - missing instructions",
		400,
		client.post("/agents", {
			name: "Broken Agent",
			model: "gpt-4.1",
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
			model: "gpt-4.1",
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
			model: "gpt-4.1",
			tools: ["unsupported_tool"],
		}),
	);

	await expectStatus(
		"9. Create Agent - disallowed metadata field",
		400,
		client.post("/agents", {
			name: "Metadata Agent",
			instructions: "You are a helpful assistant.",
			model: "gpt-4.1",
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
			model: "gpt-4.1",
			status: "active",
		}),
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

	await expectStatusForAgent(
		"12. Update Agent - description only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				description: "Handles customer support conversations.",
			}),
	);

	await expectStatusForAgent(
		"13. Update Agent - clear description",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				description: null,
			}),
	);

	await expectStatusForAgent(
		"14. Update Agent - instructions only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				instructions: "You are a concise and professional support agent.",
			}),
	);

	await expectStatusForAgent(
		"15. Update Agent - model only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				model: "gpt-4.1-mini",
			}),
	);

	await expectStatusForAgent(
		"16. Update Agent - tools only",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				tools: ["web_search"],
			}),
	);

	await expectStatusForAgent(
		"17. Update Agent - full update",
		200,
		agentId,
		(id) =>
			client.patch(`/agents/${id}`, {
				name: "Technical Support Agent",
				description: "Answers technical support questions.",
				instructions: "You help users troubleshoot technical issues.",
				model: "gpt-4.1",
				tools: ["web_search", "file_reader"],
			}),
	);

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
