import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildPayload, sessionTotals } from "./index.ts";

// sessionTotals sums message cost and spans first to last timestamp
{
	const entries = [
		{ type: "message", timestamp: "2026-08-15T00:00:00.000Z", message: { role: "user", content: "hi" } },
		{ type: "message", timestamp: "2026-08-15T00:00:30.000Z", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
		{ type: "model_change", timestamp: "2026-08-15T00:01:00.000Z" },
		{ type: "message", timestamp: "2026-08-15T00:02:00.000Z", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
	];
	const totals = sessionTotals(entries);
	assert.equal(totals.costUsd, 0.75);
	assert.equal(totals.durationMs, 120_000);
	assert.deepEqual(sessionTotals([]), { costUsd: 0, durationMs: 0 });
}

const ctx: any = {
	cwd: "/home/enor/enor_agi",
	hasUI: true,
	model: { id: "claude-opus-5", provider: "anthropic" },
	thinkingLevel: "high",
	getContextUsage: () => ({ tokens: 60_000, contextWindow: 200_000, percent: 30 }),
	sessionManager: {
		getSessionId: () => "abc-123",
		getBranch: () => [
			{ type: "message", timestamp: "2026-08-15T00:00:00.000Z", message: { role: "user", content: "hi" } },
			{ type: "message", timestamp: "2026-08-15T00:01:40.000Z", message: { role: "assistant", usage: { cost: { total: 1.5 } } } },
		],
	},
};

// buildPayload speaks the field names statusline.sh reads
{
	const payload = buildPayload(ctx, "prime-agent");
	assert.equal(payload.workspace.current_dir, "/home/enor/enor_agi");
	assert.equal(payload.model.display_name, "claude-opus-5");
	assert.equal(payload.effort.level, "high");
	assert.equal(payload.session_id, "abc-123");
	assert.equal(payload.cost.total_cost_usd, 1.5);
	assert.equal(payload.cost.total_duration_ms, 100_000);
	assert.equal(payload.context_window.remaining_percentage, 70);
}

// unknown context usage leaves the percentage empty rather than wrong
{
	const noUsage = { ...ctx, getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }) };
	assert.equal(buildPayload(noUsage as any, "prime-agent").context_window.remaining_percentage, "");
}

// the real script renders that payload
{
	const payload = JSON.stringify(buildPayload(ctx, "prime-agent"));
	const out = execFileSync("bash", ["-c", 'printf "%s" "$PI_STATUS_JSON" | "$PI_STATUS_SCRIPT"'], {
		cwd: "/home/enor/enor_agi",
		env: { ...process.env, PI_STATUS_JSON: payload, PI_STATUS_SCRIPT: "/home/enor/.claude/statusline.sh" },
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ok(out.trim().length > 0, "statusline produced no output");
	assert.ok(out.includes("claude-opus-5"), "model name missing from statusline");
	console.log("rendered:", JSON.stringify(out));
	console.log("plain   :", out.replace(/\x1b\[[0-9;]*m/g, "").trim());
}

describe("statusline", () => {
	it("behaves per the fork contract", () => {
		// (top-level assert blocks above run here)
	});
});
