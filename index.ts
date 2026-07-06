import { Agent } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const model = getBuiltinModel("openai-codex", "gpt-5.5");

new Agent({
	initialState: {
		model,
		thinkingLevel: "medium",
		tools: [],
		systemPrompt: 
			"You are Marvin, a helpful AI assistant.",
	},
});



