import { describe, expect, it, vi } from "vitest";
import { registerManus } from "./register.ts";

describe("registerManus", () => {
	it("registers the manus provider with a streamSimple handler and three models", () => {
		const registerProvider = vi.fn();
		registerManus({ registerProvider } as never);

		const [name, config] = registerProvider.mock.calls[0];
		expect(name).toBe("manus");
		expect(config.api).toBe("manus-tasks");
		expect(config.baseUrl).toBe("https://api.manus.ai");
		expect(typeof config.streamSimple).toBe("function");
		expect(config.models.map((m: { id: string }) => m.id)).toEqual([
			"manus-1.6",
			"manus-1.6-lite",
			"manus-1.6-max",
		]);
	});

	it("resolves the api key through the runner (env var name, not a literal)", () => {
		const registerProvider = vi.fn();
		registerManus({ registerProvider } as never);
		const [, config] = registerProvider.mock.calls[0];
		expect(config.apiKey).toBe("MANUS_API_KEY");
	});
});
