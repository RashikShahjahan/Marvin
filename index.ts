import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { createAgentResponse } from "./agent.ts";
import {
	createAgent,
	deleteAgent,
	getAgent,
	listAgents,
	updateAgent,
	type AgentRow,
	type AgentUpdate,
} from "./db.ts";

const app: Express = express();
const port = 3000;

const modelSchema = z.string().min(1);
const toolSchema = z.string().min(1);
const toolsSchema = z.array(toolSchema);
const createAgentSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		instructions: z.string().min(1),
		model: modelSchema,
		tools: toolsSchema.optional(),
	})
	.strict();
const updateAgentSchema = z
	.object({
		name: z.string().min(1).optional(),
		description: z.string().nullable().optional(),
		instructions: z.string().min(1).optional(),
		model: modelSchema.optional(),
		tools: toolsSchema.optional(),
	})
	.strict()
	.refine((agent) => Object.keys(agent).length > 0);
const createAgentResponseSchema = z
	.object({
		agent_id: z.string().min(1),
		message: z.string().min(1),
	})
	.strict();

const agentParamsSchema = z.object({
	id: z.string(),
});

type AgentModel = z.infer<typeof modelSchema>;
type AgentTool = z.infer<typeof toolSchema>;

type AgentResponse = {
	id: string;
	name: string;
	description: string | null;
	instructions: string;
	model: AgentModel;
	tools: string | null;
};

app.use(express.json());

function storedTools(tools: AgentTool[] | undefined): string | null {
	if (tools === undefined) {
		return null;
	}

	return JSON.stringify(tools);
}

function toAgentResponse(agent: AgentRow): AgentResponse {
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description,
		instructions: agent.instructions,
		model: modelSchema.parse(agent.model),
		tools: agent.tools,
	};
}

app.post("/agents", (request: Request, response: Response) => {
	const parseResult = createAgentSchema.safeParse(request.body);

	if (!parseResult.success) {
		response.sendStatus(400);
		return;
	}

	const agent = createAgent({
		id: `ag_${randomUUID()}`,
		name: parseResult.data.name,
		description: parseResult.data.description ?? null,
		instructions: parseResult.data.instructions,
		model: parseResult.data.model,
		tools: storedTools(parseResult.data.tools),
	});

	response.status(201).json(toAgentResponse(agent));
});

app.get("/agents", (_request: Request, response: Response) => {
	response.json({
		data: listAgents().map(toAgentResponse),
		next_cursor: null,
	});
});

app.post("/agent/responses", async (request: Request, response: Response) => {
	const parseResult = createAgentResponseSchema.safeParse(request.body);

	if (!parseResult.success) {
		response.sendStatus(400);
		return;
	}

	const agent = getAgent(parseResult.data.agent_id);

	if (agent === undefined) {
		response.sendStatus(404);
		return;
	}

	let tools: AgentTool[];
	try {
		tools =
			agent.tools === null ? [] : toolsSchema.parse(JSON.parse(agent.tools));
	} catch {
		response.sendStatus(400);
		return;
	}

	const message = await createAgentResponse(
		agent.instructions,
		parseResult.data.message,
		tools,
	);

	response.json({
		message,
	});
});

app.get("/agents/:id", (request: Request, response: Response) => {
	const params = agentParamsSchema.parse(request.params);
	const agent = getAgent(params.id);

	if (agent === undefined) {
		response.sendStatus(404);
		return;
	}

	response.json(toAgentResponse(agent));
});

app.patch("/agents/:id", (request: Request, response: Response) => {
	const params = agentParamsSchema.parse(request.params);
	const parseResult = updateAgentSchema.safeParse(request.body);

	if (!parseResult.success) {
		response.sendStatus(400);
		return;
	}

	const { tools, ...fields } = parseResult.data;
	const changes: AgentUpdate = {
		...fields,
		...(tools !== undefined ? { tools: storedTools(tools) } : {}),
	};

	const agent = updateAgent(params.id, changes);

	if (agent === undefined) {
		response.sendStatus(404);
		return;
	}

	response.json(toAgentResponse(agent));
});

app.delete("/agents/:id", (request: Request, response: Response) => {
	const params = agentParamsSchema.parse(request.params);
	const deleteResult = deleteAgent(params.id);

	if (deleteResult === "missing") {
		response.sendStatus(404);
		return;
	}

	response.sendStatus(204);
});

app.listen(port);
