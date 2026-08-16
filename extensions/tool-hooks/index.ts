import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Ports the two Claude Code PreToolUse hooks that still had no Prime side:
//   `rtk hook claude`  — rewrites shell commands to their token-cheap rtk form
//   `ecp hook <event>` — graph hits before a search, reindex after a git mutation,
//                        marker drains per turn, and the structural-dispatch gate
// Both speak the Claude envelope on stdin and Claude JSON on stdout, so this
// extension only translates shapes. Neither CLI is modified.

const HOOK_TIMEOUT_MS = 5000;
const ECP = `${process.env.HOME}/.local/bin/ecp`;
const NUDGE = `${process.env.HOME}/.claude/hooks/ecp-graph-nudge.sh`;
const GUARDS = [`${process.env.HOME}/.claude/hooks/guard-push-simplify.sh`];

export interface ClaudeHookOutput {
	additionalContext?: string;
	permissionDecision?: string;
	permissionDecisionReason?: string;
	updatedInput?: { command?: string };
}

/** Shell body of an IPython `%%bash` cell, or undefined for a Python cell. */
export function bashBody(code: string): string | undefined {
	const match = /^[ \t]*%%bash[^\n]*\n?/.exec(code);
	return match ? code.slice(match[0].length) : undefined;
}

/** First string literal passed to `rlm(...)`, which carries the sub-agent task. */
export function rlmTask(code: string): string | undefined {
	const match = /\brlm\(\s*[a-zA-Z]?("""|'''|"|')([\s\S]*?)\1/.exec(code);
	return match?.[2]?.trim() || undefined;
}

/** `hookSpecificOutput` of a Claude hook, or undefined when the hook stayed silent. */
export function parseHookOutput(stdout: string): ClaudeHookOutput | undefined {
	const text = stdout.trim();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text).hookSpecificOutput;
	} catch {
		return undefined; // A hook that prints anything else is treated as a no-op.
	}
}

export default function (pi: ExtensionAPI) {
	const pendingContext = new Map<string, string>();
	let carried: string[] = [];

	const runHook = async (
		command: string,
		args: string[],
		envelope: unknown,
		ctx: ExtensionContext,
	): Promise<ClaudeHookOutput | undefined> => {
		try {
			const result = await pi.exec("bash", ["-c", 'printf "%s" "$PI_HOOK_JSON" | "$PI_HOOK_CMD" "$@"', "bash", ...args], {
				cwd: ctx.cwd,
				timeout: HOOK_TIMEOUT_MS,
				env: { PI_HOOK_JSON: JSON.stringify(envelope), PI_HOOK_CMD: command },
			});
			return parseHookOutput(result.stdout ?? "");
		} catch {
			return undefined; // A hook that fails never blocks the turn.
		}
	};

	const ecpHook = (event: string, envelope: unknown, ctx: ExtensionContext) =>
		runHook(ECP, ["hook", event, "--claude-code"], envelope, ctx);

	pi.on("session_start", async (_event, ctx) => {
		if (!existsSync(ECP)) return;
		const output = await ecpHook("session-start", { cwd: ctx.cwd }, ctx);
		if (output?.additionalContext) carried.push(output.additionalContext);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (existsSync(ECP)) {
			const output = await ecpHook("user-prompt-submit", { cwd: ctx.cwd }, ctx);
			if (output?.additionalContext) carried.push(output.additionalContext);
		}
		if (carried.length === 0) return;
		const content = carried.join("\n\n");
		carried = [];
		return { message: { customType: "ecp", content: `[ecp]\n${content}`, display: true } };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as { code?: string; command?: string };
		const isIpython = event.toolName === "ipython";
		const body = isIpython ? bashBody(input.code ?? "") : event.toolName === "bash" ? input.command : undefined;

		if (isIpython && body === undefined) {
			// A Python cell that spawns a sub-agent is this harness's Task dispatch.
			const task = rlmTask(input.code ?? "");
			if (task === undefined) return;
			const output = await ecpHook(
				"agent-dispatch",
				{ cwd: ctx.cwd, tool_name: "Task", tool_input: { subagent_type: "general-purpose", prompt: task } },
				ctx,
			);
			if (output?.permissionDecision === "deny") {
				return { block: true, reason: output.permissionDecisionReason ?? "Blocked by ecp" };
			}
			return;
		}
		if (body === undefined || body.trim().length === 0) return;

		const envelope = {
			cwd: ctx.cwd,
			tool_name: "Bash",
			tool_input: { command: body },
			transcript_path: ctx.sessionManager?.getSessionFile?.(),
		};

		// Claude Code guards live in ~/.claude/hooks and speak the same JSON on stdout.
		for (const guard of GUARDS) {
			if (!existsSync(guard)) continue;
			const verdict = await runHook(guard, [], envelope, ctx);
			if (verdict?.permissionDecision === "deny") {
				return { block: true, reason: verdict.permissionDecisionReason ?? `Blocked by ${guard}` };
			}
		}

		// The nudge wrapper adds the follow-up `ecp impact` command to ecp's own d=1 slice.
		// One implementation, shared with Claude Code, so the two hosts cannot drift.
		const graph = existsSync(NUDGE)
			? await runHook(NUDGE, [], envelope, ctx)
			: existsSync(ECP)
				? await ecpHook("pre-tool-use", envelope, ctx)
				: undefined;
		if (graph?.additionalContext) pendingContext.set(event.toolCallId, graph.additionalContext);

		const rewritten = (await runHook("rtk", ["hook", "claude"], envelope, ctx))?.updatedInput?.command;
		if (rewritten === undefined || rewritten === body) return;
		if (isIpython) input.code = `%%bash\n${rewritten}`;
		else input.command = rewritten;
	});

	pi.on("tool_result", async (event, ctx) => {
		const graphHits = pendingContext.get(event.toolCallId);
		pendingContext.delete(event.toolCallId);

		const input = event.input as { code?: string; command?: string };
		const body = event.toolName === "ipython" ? bashBody(input.code ?? "") : input.command;
		if (body !== undefined && existsSync(ECP)) {
			// Git mutations kick off a background reindex; the hook is normally silent.
			await ecpHook(
				"post-tool-use",
				{ cwd: ctx.cwd, tool_name: "Bash", tool_input: { command: body }, tool_output: {} },
				ctx,
			);
		}
		if (graphHits === undefined) return;
		return { content: [{ type: "text", text: graphHits }, ...event.content] };
	});
}
