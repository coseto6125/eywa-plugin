import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Port of ~/.claude/hooks/eywa-inject.sh (UserPromptSubmit) to a Pi extension.
// The Claude hook keeps running unchanged; both talk to the same eywa server and
// share ~/.eywa/session_cache and ~/.eywa/recent.log. The transcript is read from
// this extension's own turn buffer, because Pi sessions are not Claude JSONL.

const SERVER = "http://127.0.0.1:8788";
const CACHE_DIR = resolve(homedir(), ".eywa/session_cache");
const RECENT_LOG = resolve(homedir(), ".eywa/recent.log");
const QUERY_TIMEOUT_MS = 5000;
const HISTORY_TURNS = 8;
const HISTORY_CHARS = 4000;

/** Cache key of a principle line: first 80 bytes, non-alphanumerics squeezed to `-`. */
export function cacheKey(line: string): string {
	const head = Buffer.from(line, "utf8").subarray(0, 80).toString("utf8");
	return `k:${head.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
}

/** Principle lines from a smart-query body, dropping notices and error payloads. */
export function parseResults(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("<!--"))
		.filter((line) => !/^error[: ]/.test(line));
}

/** Preceding user and assistant turns as `role: text`, newest last, clipped to the tail budget. */
export function formatHistory(entries: readonly any[]): string {
	const turns: string[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message.content).trim();
		if (text.length > 0) turns.push(`${role}: ${text}`);
	}
	return turns.slice(-HISTORY_TURNS).join("\n").slice(-HISTORY_CHARS);
}

/** Plain text of a message whose content is a string or a block array. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

async function queryEywa(context: string, cwd: string, history: string): Promise<string> {
	const response = await fetch(`${SERVER}/smart-query`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ context, cwd, history }),
		signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
	});
	// A non-2xx body is an error payload, not a principle: drop it, as `curl -f` does.
	return response.ok ? await response.text() : "";
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = event.prompt?.trim() ?? "";
		if (prompt.length === 0) return;
		// Most prompts are too short to search alone, so the preceding turns ride along
		// and the server budgets them. Restored and forked sessions carry their history
		// here too, because it is read from the session rather than kept in memory.
		const history = formatHistory(ctx.sessionManager.getBranch());

		let body = "";
		try {
			body = await queryEywa(prompt, ctx.cwd, history);
		} catch {
			return; // Server down or slow: inject nothing, say nothing.
		}
		const lines = parseResults(body);
		if (lines.length === 0) return;

		const sessionId = ctx.sessionManager.getSessionId?.() ?? "default";
		const cacheFile = resolve(CACHE_DIR, `${sessionId}.txt`);
		mkdirSync(CACHE_DIR, { recursive: true });
		let seen: string[] = [];
		try {
			seen = readFileSync(cacheFile, "utf8").split("\n");
		} catch {
			writeFileSync(cacheFile, "");
		}

		const fresh = lines.filter((line) => !seen.includes(cacheKey(line)));
		if (fresh.length === 0) return;

		appendFileSync(cacheFile, `${fresh.map(cacheKey).join("\n")}\n`);
		const stamp = new Date().toTimeString().slice(0, 8);
		appendFileSync(RECENT_LOG, `${fresh.map((line) => `INJECT ${stamp} ${line}`).join("\n")}\n`);

		return {
			message: {
				customType: "eywa",
				content: `[eywa]\n${fresh.join("\n")}`,
				display: true,
			},
		};
	});
}
