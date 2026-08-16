import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import extension, { bashBody, parseHookOutput, rlmTask } from "./index.ts";

const REPO = "/home/enor/enor_agi/eywa"; // a repo with an ecp index

// bashBody separates shell cells from Python cells
{
	assert.equal(bashBody("%%bash\ngit status\n"), "git status\n");
	assert.equal(bashBody("  %%bash  \nls"), "ls");
	assert.equal(bashBody("print('hi')"), undefined);
	assert.equal(bashBody("x = 1\n%%bash\nls"), undefined);
}

// rlmTask reads the task out of every quoting style, and ignores cells with no spawn
{
	assert.equal(rlmTask("h = await rlm('who calls loadSkills')"), "who calls loadSkills");
	assert.equal(rlmTask('await rlm("trace the call flow", name="x")'), "trace the call flow");
	assert.equal(rlmTask('await rlm(f"""\n  blast radius of rerank\n""")'), "blast radius of rerank");
	assert.equal(rlmTask("await rlm.list_subagents()"), undefined);
	assert.equal(rlmTask("print('rlm(')"), undefined);
}

// parseHookOutput unwraps hook JSON and treats anything else as silence
{
	assert.equal(parseHookOutput(""), undefined);
	assert.equal(parseHookOutput("not json"), undefined);
	assert.deepEqual(parseHookOutput('{"hookSpecificOutput":{"additionalContext":"hi"}}'), { additionalContext: "hi" });
}

// --- handler tests against the real ecp and rtk binaries ---

const handlers: Record<string, Function[]> = {};
const pi: any = {
	on: (name: string, fn: Function) => ((handlers[name] ??= []).push(fn)),
	exec: async (command: string, args: string[], options: any) => {
		const stdout = execFileSync(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			encoding: "utf8",
			timeout: options.timeout,
		});
		return { stdout, stderr: "", code: 0, killed: false };
	},
};
extension(pi);
const ctx: any = { cwd: REPO };
const toolCall = handlers["tool_call"][0];
const toolResult = handlers["tool_result"][0];

// rtk rewrites a shell cell in place, and the cell keeps its %%bash header
{
	const event: any = { toolName: "ipython", toolCallId: "call-1", input: { code: "%%bash\ngit status" } };
	assert.equal(await toolCall(event, ctx), undefined);
	assert.equal(event.input.code, "%%bash\nrtk git status");
}

// a command rtk leaves alone is not touched
{
	const event: any = { toolName: "ipython", toolCallId: "call-2", input: { code: "%%bash\nfor d in */; do echo $d; done" } };
	await toolCall(event, ctx);
	assert.equal(event.input.code, "%%bash\nfor d in */; do echo $d; done");
}

// a grep cell collects graph hits, which land on top of that call's result
{
	const event: any = { toolName: "ipython", toolCallId: "call-3", input: { code: "%%bash\ngrep -rn build_search_text src" } };
	await toolCall(event, ctx);
	const patch = await toolResult({ toolName: "ipython", toolCallId: "call-3", input: event.input, content: [{ type: "text", text: "grep output" }] }, ctx);
	assert.ok(patch, "expected the graph hits to patch the result");
	assert.ok(patch.content[0].text.startsWith("ecp graph hits:"), patch.content[0].text.slice(0, 40));
	assert.equal(patch.content[1].text, "grep output");
}

// a result with no pending hits is left as it is
{
	const patch = await toolResult({ toolName: "ipython", toolCallId: "unknown", input: { code: "print(1)" }, content: [{ type: "text", text: "1" }] }, ctx);
	assert.equal(patch, undefined);
}

// a structural sub-agent spawn is blocked with ecp's own reason
{
	const event: any = { toolName: "ipython", toolCallId: "call-4", input: { code: "h = await rlm('trace all callers of build_search_text and the blast radius')" } };
	const decision: any = await toolCall(event, ctx);
	assert.equal(decision?.block, true);
	assert.match(decision.reason, /ecp find/);
}

// a spawn that is not a structural lookup passes through
{
	const event: any = { toolName: "ipython", toolCallId: "call-5", input: { code: "h = await rlm('write the release notes for v2 in Traditional Chinese')" } };
	assert.equal(await toolCall(event, ctx), undefined);
}

// a plain Python cell never reaches a hook
{
	const event: any = { toolName: "ipython", toolCallId: "call-6", input: { code: "x = 1 + 1" } };
	assert.equal(await toolCall(event, ctx), undefined);
	assert.equal(event.input.code, "x = 1 + 1");
}

describe("tool-hooks", () => {
	it("behaves per the fork contract", () => {
		// (top-level assert blocks above run here)
	});
});
