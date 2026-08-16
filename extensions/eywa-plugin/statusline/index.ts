import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Renders ~/.claude/statusline.sh inside Pi. The script is unchanged: it reads a
// Claude Code status JSON on stdin, so this extension builds that same shape from
// Pi's session state and shows the output as a widget below the editor.

const SCRIPT = resolve(homedir(), ".claude/statusline.sh");
const REFRESH_MS = 30_000;
const THROTTLE_MS = 1000;
const RENDER_TIMEOUT_MS = 5000;
const AGENT_NAME = "prime-agent";

export interface StatusPayload {
	cwd: string;
	workspace: { current_dir: string };
	model: { display_name: string; version: string };
	effort: { level: string };
	session_id: string;
	version: string;
	output_style: { name: string };
	cost: { total_cost_usd: number; total_duration_ms: number };
	context_window: { remaining_percentage: number | "" };
}

/** Total cost in USD and wall-clock span in ms over the session entries. */
export function sessionTotals(entries: readonly any[]): { costUsd: number; durationMs: number } {
	let costUsd = 0;
	let first: number | undefined;
	let last: number | undefined;
	for (const entry of entries) {
		const cost = entry?.message?.usage?.cost?.total;
		if (typeof cost === "number") costUsd += cost;
		const stamp = Date.parse(entry?.timestamp ?? "");
		if (Number.isNaN(stamp)) continue;
		if (first === undefined) first = stamp;
		last = stamp;
	}
	return { costUsd, durationMs: first === undefined || last === undefined ? 0 : last - first };
}

/** The Claude Code status JSON that statusline.sh parses. */
export function buildPayload(ctx: ExtensionContext, agentVersion: string): StatusPayload {
	const usage = ctx.getContextUsage?.();
	const percent = usage?.percent;
	const totals = sessionTotals(ctx.sessionManager.getBranch());
	return {
		cwd: ctx.cwd,
		workspace: { current_dir: ctx.cwd },
		model: { display_name: ctx.model?.id ?? "prime", version: ctx.model?.provider ?? "-" },
		effort: { level: ctx.thinkingLevel ?? "-" },
		session_id: ctx.sessionManager.getSessionId?.() ?? "-",
		version: agentVersion,
		output_style: { name: "colleague-zh" },
		cost: { total_cost_usd: totals.costUsd, total_duration_ms: totals.durationMs },
		context_window: { remaining_percentage: typeof percent === "number" ? Math.max(0, Math.round(100 - percent)) : "" },
	};
}

export default function (pi: ExtensionAPI) {
	if (!existsSync(SCRIPT)) return;
	let timer: NodeJS.Timeout | undefined;
	let lastRenderAt = 0;
	let rendering = false;

	const render = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || rendering) return;
		const now = Date.now();
		if (now - lastRenderAt < THROTTLE_MS) return;
		lastRenderAt = now;
		rendering = true;
		try {
			// pi.exec has no stdin, and the script reads its JSON from stdin: hand the
			// payload over in the environment and let the shell pipe it in.
			const result = await pi.exec("bash", ["-c", 'printf "%s" "$PI_STATUS_JSON" | "$PI_STATUS_SCRIPT"'], {
				cwd: ctx.cwd,
				timeout: RENDER_TIMEOUT_MS,
				env: { PI_STATUS_JSON: JSON.stringify(buildPayload(ctx, AGENT_NAME)), PI_STATUS_SCRIPT: SCRIPT },
			});
			const lines = (result.stdout ?? "").split("\n").filter((line) => line.trim().length > 0);
			ctx.ui.setWidget("claude-statusline", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
		} catch {
			// A failing statusline stays invisible rather than interrupting the session.
		} finally {
			rendering = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		void render(ctx);
		if (timer === undefined) {
			timer = setInterval(() => void render(ctx), REFRESH_MS);
			timer.unref();
		}
	});
	pi.on("turn_end", (_event, ctx) => void render(ctx));
	pi.on("agent_settled", (_event, ctx) => void render(ctx));
	pi.on("model_select", (_event, ctx) => void render(ctx));
	pi.on("thinking_level_select", (_event, ctx) => void render(ctx));
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerCommand("statusline", {
		description: "Re-render the Claude statusline now",
		handler: async (_args, ctx) => {
			lastRenderAt = 0;
			await render(ctx);
		},
	});
}
