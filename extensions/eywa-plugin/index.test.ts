import { describe, expect, it } from "vitest";
import { softenFirstCell } from "./index.ts";

describe("softenFirstCell", () => {
	it("prefixes a python cell with the soften snippet", () => {
		const out = softenFirstCell("x = 1");
		expect(out).toContain("_ep_soften_script_magics");
		expect(out).toEndWith("x = 1");
	});

	it("replays a %%bash cell through run_cell_magic", () => {
		const out = softenFirstCell("%%bash\ngrep foo bar.txt")!;
		expect(out).toContain('run_cell_magic("bash", "", "grep foo bar.txt")');
		expect(out).toContain("_ep_soften_script_magics");
	});

	it("leaves an already-softened cell untouched", () => {
		expect(softenFirstCell("_ep_soften_script_magics()\nx = 1")).toBeUndefined();
	});

	it("keeps the magic line argument", () => {
		const out = softenFirstCell("%%bash -e\nfalse")!;
		expect(out).toContain('run_cell_magic("bash", "-e", "false")');
	});
});
