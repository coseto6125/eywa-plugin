/**
 * Manus provider registration.
 *
 * The stock runner ships no Manus support, so the provider is registered here
 * with a custom streamSimple handler: the same Manus task bridge the Eywa fork
 * built (task.create + poll task.listMessages, tool bridging via the prompt).
 * The fork's provider files live in ./manus.ts and its siblings, with their
 * imports rewritten to the stock "@earendil-works/pi-ai" package.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimpleManus } from "./manus.ts";

const MANUS_API = "manus-tasks" as Api;

interface ManusModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

const manusModels: ManusModelDef[] = [
	{
		id: "manus-1.6",
		name: "Manus 1.6",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	},
	{
		id: "manus-1.6-lite",
		name: "Manus 1.6 Lite",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	},
	{
		id: "manus-1.6-max",
		name: "Manus 1.6 Max",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	},
];

export function registerManus(pi: ExtensionAPI): void {
	pi.registerProvider("manus", {
		name: "Manus",
		baseUrl: "https://api.manus.ai",
		// Resolved by the runner (env var, or the apiKey from models.json). The
		// streamSimple call then receives it in options.apiKey.
		apiKey: "MANUS_API_KEY",
		api: MANUS_API,
		streamSimple: (model, context, options) =>
			streamSimpleManus(model as Model<"manus-tasks">, context, options),
		models: manusModels,
	});
}
