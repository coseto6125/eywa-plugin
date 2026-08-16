import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { cacheKey, formatHistory, messageText, parseResults } from "./index.ts";

// parseResults keeps principles, drops notices, blanks and error payloads
{
	const body = "\n[a][b] first\n<!-- conflict -->\nerror: boom\nerror boom\n[c] second\n";
	assert.deepEqual(parseResults(body), ["[a][b] first", "[c] second"]);
}

// cacheKey is stable, lowercase, and never starts with a dash
{
	const key = cacheKey("[philosophy][architecture] Store persistent agent configurations here");
	assert.ok(key.startsWith("k:"));
	assert.equal(key, key.toLowerCase());
	assert.equal(cacheKey("[a] x"), cacheKey("[a] x"));
	assert.notEqual(cacheKey("[a] x"), cacheKey("[a] y"));
}

// cacheKey clips at 80 bytes, so two lines sharing a long prefix collapse to one key
{
	const prefix = "[methodology][workflow] ".padEnd(90, "z");
	assert.equal(cacheKey(`${prefix}AAA`), cacheKey(`${prefix}BBB`));
}

// cacheKey survives multi-byte text cut mid-character
{
	const key = cacheKey("[中文] 這是一段很長的中文原則內容用來測試位元組切斷的情形不應該爆炸");
	assert.ok(key.startsWith("k:"));
}

// formatHistory keeps the newest user and assistant turns, oldest first
{
	const entries = [
		...Array.from({ length: 12 }, (_, i) => ({ type: "message", message: { role: "user", content: `t${i}` } })),
		{ type: "message", message: { role: "toolResult", content: "tool noise" } },
		{ type: "model_change", provider: "anthropic", modelId: "x" },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
	];
	const history = formatHistory(entries);
	assert.ok(!history.includes("tool noise"), "tool results must not reach the query");
	assert.equal(history.split("\n").length, 8);
	assert.ok(history.startsWith("user: t5"), history.slice(0, 20));
	assert.ok(history.endsWith("assistant: done"));
}

// formatHistory clips to the tail budget and tolerates empty input
{
	const entries = [{ type: "message", message: { role: "assistant", content: "x".repeat(9000) } }];
	assert.equal(formatHistory(entries).length, 4000);
	assert.equal(formatHistory([]), "");
}

// messageText handles both content shapes
{
	assert.equal(messageText("plain"), "plain");
	assert.equal(messageText([{ type: "text", text: "a" }, { type: "thinking", text: "z" }, { type: "text", text: "b" }]), "a b");
	assert.equal(messageText(undefined), "");
}

describe("eywa", () => {
	it("behaves per the fork contract", () => {
		// (top-level assert blocks above run here)
	});
});
