import { runCli } from "../cli.ts";
import { describe, expect, test } from "bun:test";

type RequestRecord = {
	url: string;
	init: RequestInit | undefined;
	body: string | undefined;
};

function jsonFetch(responseData: unknown, status = 200) {
	const requests: RequestRecord[] = [];

	async function fetcher(url: string, init?: RequestInit): Promise<Response> {
		const body = typeof init?.body === "string" ? init.body : undefined;
		requests.push({ url, init, body });

		return new Response(JSON.stringify(responseData), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	return { fetcher, requests };
}

function emptyFetch(status = 204) {
	const requests: RequestRecord[] = [];

	async function fetcher(url: string, init?: RequestInit): Promise<Response> {
		const body = typeof init?.body === "string" ? init.body : undefined;
		requests.push({ url, init, body });

		return new Response(null, { status });
	}

	return { fetcher, requests };
}

function createOutput() {
	const lines: string[] = [];

	return {
		lines,
		write(line: string): void {
			lines.push(line);
		},
	};
}

describe("CLI", () => {
	test("lists agents", async () => {
		const mock = jsonFetch({ data: [], next_cursor: null });
		const output = createOutput();

		await runCli(["agents", "list"], {
			apiUrl: "http://api.test",
			fetch: mock.fetcher,
			write: output.write,
		});

		expect(mock.requests).toHaveLength(1);
		expect(mock.requests[0]?.url).toBe("http://api.test/agents");
		expect(mock.requests[0]?.init?.method).toBe("GET");
		expect(output.lines).toEqual([
			JSON.stringify({ data: [], next_cursor: null }, null, 2),
		]);
	});

	test("creates an agent", async () => {
		const mock = jsonFetch({ id: "ag_123" }, 201);
		const output = createOutput();

		await runCli(
			[
				"agents",
				"create",
				"--name",
				"Support Agent",
				"--description",
				"Answers support questions.",
				"--instructions",
				"Be helpful.",
				"--model",
				"gpt-4.1",
				"--tool",
				"read",
				"--tool",
				"write",
			],
			{
				apiUrl: "http://api.test",
				fetch: mock.fetcher,
				write: output.write,
			},
		);

		expect(mock.requests).toHaveLength(1);
		expect(mock.requests[0]?.url).toBe("http://api.test/agents");
		expect(mock.requests[0]?.init?.method).toBe("POST");
		expect(mock.requests[0]?.body).toBe(
			JSON.stringify({
				name: "Support Agent",
				description: "Answers support questions.",
				instructions: "Be helpful.",
				model: "gpt-4.1",
				tools: ["read", "write"],
			}),
		);
		expect(output.lines).toEqual([JSON.stringify({ id: "ag_123" }, null, 2)]);
	});

	test("updates an agent", async () => {
		const mock = jsonFetch({ id: "ag_123", name: "Updated Agent" });
		const output = createOutput();

		await runCli(
			[
				"agents",
				"update",
				"ag_123",
				"--name",
				"Updated Agent",
				"--model",
				"gpt-4.1-mini",
			],
			{
				apiUrl: "http://api.test",
				fetch: mock.fetcher,
				write: output.write,
			},
		);

		expect(mock.requests).toHaveLength(1);
		expect(mock.requests[0]?.url).toBe("http://api.test/agents/ag_123");
		expect(mock.requests[0]?.init?.method).toBe("PATCH");
		expect(mock.requests[0]?.body).toBe(
			JSON.stringify({ name: "Updated Agent", model: "gpt-4.1-mini" }),
		);
		expect(output.lines).toEqual([
			JSON.stringify({ id: "ag_123", name: "Updated Agent" }, null, 2),
		]);
	});

	test("deletes an agent", async () => {
		const mock = emptyFetch();
		const output = createOutput();

		await runCli(["agents", "delete", "ag_123"], {
			apiUrl: "http://api.test",
			fetch: mock.fetcher,
			write: output.write,
		});

		expect(mock.requests).toHaveLength(1);
		expect(mock.requests[0]?.url).toBe("http://api.test/agents/ag_123");
		expect(mock.requests[0]?.init?.method).toBe("DELETE");
		expect(output.lines).toEqual([JSON.stringify({ status: 204 }, null, 2)]);
	});

	test("creates an agent response", async () => {
		const mock = jsonFetch({ message: "Hello", conversation_id: "conv_123" });
		const output = createOutput();

		await runCli(
			[
				"responses",
				"create",
				"--agent-id",
				"ag_123",
				"--conversation-id",
				"conv_123",
				"--message",
				"Hello?",
			],
			{
				apiUrl: "http://api.test",
				fetch: mock.fetcher,
				write: output.write,
			},
		);

		expect(mock.requests).toHaveLength(1);
		expect(mock.requests[0]?.url).toBe("http://api.test/agent/responses");
		expect(mock.requests[0]?.init?.method).toBe("POST");
		expect(mock.requests[0]?.body).toBe(
			JSON.stringify({
				agent_id: "ag_123",
				conversation_id: "conv_123",
				message: "Hello?",
			}),
		);
		expect(output.lines).toEqual([
			JSON.stringify(
				{ message: "Hello", conversation_id: "conv_123" },
				null,
				2,
			),
		]);
	});
});
