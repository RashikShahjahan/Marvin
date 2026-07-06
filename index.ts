import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";

const app: Express = express();
const port = 3000;

const modelSchema = z.enum(["gpt-4.1", "gpt-4.1-mini"]);
const toolSchema = z.enum(["web_search", "file_reader"]);
const createAgentSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		instructions: z.string().min(1),
		model: modelSchema,
		tools: z.array(toolSchema).optional(),
	})
	.strict();

type AgentModel = z.infer<typeof modelSchema>;
type AgentTool = z.infer<typeof toolSchema>;

type AgentRecord = {
	id: string;
	name: string;
	description?: string;
	instructions: string;
	model: AgentModel;
	tools?: AgentTool[];
};

const agents = new Map<string, AgentRecord>();
let nextAgentNumber = 1;

app.use(express.json());

app.post("/agents", (request: Request, response: Response) => {
	const parseResult = createAgentSchema.safeParse(request.body);

	if (!parseResult.success) {
		response.sendStatus(400);
		return;
	}

	const id = `ag_${nextAgentNumber}`;
	nextAgentNumber += 1;

	const agent: AgentRecord = {
		id,
		...parseResult.data,
	};

	agents.set(id, agent);
	response.status(201).json(agent);
});

app.listen(port, () => {
	console.log(`Listening on port ${port}`);
});
