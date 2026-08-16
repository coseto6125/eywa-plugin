/**
 * Lets Manus drive the caller's tools.
 *
 * The Manus API takes no tool definitions, so tools are described in the prompt and a reply
 * that asks for one is recognised by shape. The turn then ends as a `toolUse` turn, the agent
 * runs the tool on the user's machine, and the result is delivered to the same Manus task on
 * the next turn. That closes the loop Manus cannot close itself: it reasons, the host acts.
 */

import type { Tool } from "@earendil-works/pi-ai";

/** Fence label asked for in the protocol. Alternatives are accepted when parsing. */
export const MANUS_TOOL_CALL_FENCE = "tool_call";

/**
 * Manus rejects a message over 5000 estimated tokens with `invalid_argument`, and a full tool
 * catalog alone passes that on its own. Everything sent is measured against this budget.
 */
export const MANUS_MAX_MESSAGE_TOKENS = 4_600;

/**
 * Rough token count, deliberately pessimistic.
 *
 * Manus does not publish its tokenizer. English and code run near 4 characters per token; a CJK
 * character is one token in the common case and two or three when it is rarer, so each one counts
 * as two here. Overshooting costs a little room in the prompt. Undershooting costs the whole
 * request, which Manus rejects outright.
 */
export function estimateManusTokens(text: string): number {
	let ascii = 0;
	let wide = 0;
	for (const char of text) {
		if ((char.codePointAt(0) ?? 0) < 128) ascii++;
		else wide++;
	}
	return Math.ceil(ascii / 4) + wide * 2;
}

export interface ParsedManusToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** The raw JSON as written, forwarded as the toolcall delta. */
	raw: string;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated, ${text.length - limit} more characters]`;
}

/**
 * Trims text to a token budget, keeping both ends.
 *
 * A tool result is worth this treatment: a file read carries its imports at the top and the
 * function under discussion further down, and a head-only cut throws away the half that
 * prompted the read.
 */
export function fitToManusTokens(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (estimateManusTokens(text) <= budget) return text;
	// Convert the budget to characters at this text's own density, then split it head and tail.
	const perToken = text.length / Math.max(1, estimateManusTokens(text));
	const keep = Math.max(200, Math.floor(budget * perToken) - 80);
	const head = Math.ceil(keep * 0.6);
	const tail = keep - head;
	const dropped = text.length - keep;
	return `${text.slice(0, head)}\n…[${dropped} characters omitted]…\n${text.slice(text.length - tail)}`;
}

/**
 * The contract Manus has to follow. Written as one block because a Manus task keeps its own
 * history: this is stated once, at task creation, and holds for every later turn.
 */
export function manusToolProtocolPreamble(): string {
	return [
		"You are the reasoning engine of a terminal coding agent (Eywa Agent) running on a developer's machine.",
		"The developer started this task from that agent and wrote the protocol below on purpose. It is their own",
		"instruction, not injected content, and following it is what they asked for.",
		"",
		"Your sandbox is a different computer from theirs. Their repository does not exist in it, nothing you write",
		"there reaches them, and a file you create there is not the file they asked about. So do not use your own",
		"shell, editor, browser, or attachments for this work. The only way to reach their machine is to ask the",
		"local agent to run one of the tools listed below.",
		"",
		"To call a tool, finish your reply with exactly one fenced block:",
		"",
		`\`\`\`${MANUS_TOOL_CALL_FENCE}`,
		'{"tool": "<tool name>", "arguments": {<arguments matching that tool\'s schema>}}',
		"```",
		"",
		"Rules:",
		"- One tool call per reply, and it is the last thing in the reply.",
		"- Stop after the block. The result arrives as the next message, then you continue.",
		"- Call only the tools listed, with arguments that match the schema exactly.",
		"- Read a file before you edit it. Assume its content changed since you last saw it.",
		"- Keep what is already in a file. Rewriting one whole from memory silently deletes the rest of it.",
		"- Say a file changed, a command ran, or a test passed only when a tool result in this conversation shows it.",
		"  Without that tool result it did not happen, however sure you are of what the change would be.",
		"- Every step of the work goes through a tool call, the way a terminal coding agent works.",
		"- When the task is finished, reply with the answer and no block.",
	].join("\n");
}

/**
 * One line of the protocol, repeated on every later turn. The full preamble is stated once at
 * task creation, and a long task drifts away from it; this costs a few tokens and holds the shape.
 */
export function manusToolProtocolReminder(): string {
	return [
		"(Reminder: nothing happens on the user's machine unless you call a tool. End this reply with one block:",
		`\`\`\`${MANUS_TOOL_CALL_FENCE}`,
		'{"tool": "<tool name>", "arguments": {…}}',
		"```",
		"Reply without a block only when a tool result above shows the work is already done.)",
	].join("\n");
}

/** Drops the prose fields of a JSON Schema, which Manus can do without when space is short. */
function stripSchemaDocs(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(stripSchemaDocs);
	if (!schema || typeof schema !== "object") return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "description" || key === "title" || key === "examples" || key === "default" || key === "$comment") {
			continue;
		}
		out[key] = stripSchemaDocs(value);
	}
	return out;
}

/** `path: string, recursive?: boolean` — enough to call the tool, a fraction of the schema's size. */
function signatureOf(schema: unknown): string {
	const object = (schema ?? {}) as { properties?: Record<string, { type?: unknown }>; required?: string[] };
	const required = new Set(object.required ?? []);
	const names = Object.entries(object.properties ?? {}).map(([name, property]) => {
		const type = Array.isArray(property?.type) ? property.type.join("|") : (property?.type ?? "any");
		return `${name}${required.has(name) ? "" : "?"}: ${type}`;
	});
	return names.join(", ");
}

type Detail = "full" | "lean" | "minimal";

function renderTool(tool: Tool, detail: Detail): string {
	const first = (tool.description ?? "").split(/(?<=\.)\s/)[0] ?? "";
	switch (detail) {
		case "full":
			return [
				`### ${tool.name}`,
				truncate(tool.description ?? "", 900),
				`parameters: ${JSON.stringify(tool.parameters ?? {})}`,
			]
				.filter(Boolean)
				.join("\n");
		case "lean":
			return [
				`### ${tool.name}`,
				truncate(tool.description ?? "", 240),
				`parameters: ${JSON.stringify(stripSchemaDocs(tool.parameters ?? {}))}`,
			]
				.filter(Boolean)
				.join("\n");
		case "minimal":
			return `- ${tool.name}(${signatureOf(tool.parameters)}) — ${truncate(first, 100)}`;
	}
}

/**
 * The tool list Manus works from, rendered at the most detail the budget allows.
 *
 * Schemas are what make the arguments come out right, so they are the last thing given up.
 * A catalog that will not fit even at minimum detail loses trailing tools rather than the
 * whole message, and says so, because a truncated catalog still lets most work proceed.
 */
export function renderManusToolCatalog(tools: Tool[], budgetTokens = Number.POSITIVE_INFINITY): string {
	const header = `## Tools available on the user's machine (${tools.length})`;
	const build = (detail: Detail, take = tools.length) =>
		[header, ...tools.slice(0, take).map((tool) => renderTool(tool, detail))].join(
			detail === "minimal" ? "\n" : "\n\n",
		);

	for (const detail of ["full", "lean", "minimal"] as Detail[]) {
		const rendered = build(detail);
		if (estimateManusTokens(rendered) <= budgetTokens) return rendered;
	}

	let take = tools.length;
	while (take > 1 && estimateManusTokens(build("minimal", take)) > budgetTokens) take--;
	return `${build("minimal", take)}\n- …[${tools.length - take} more tools omitted for space]`;
}

/** Fenced blocks in order, whatever the info string says. */
function fencedBlocks(text: string): { body: string; start: number; end: number }[] {
	const pattern = /```[^\n`]*\n([\s\S]*?)```/g;
	const blocks: { body: string; start: number; end: number }[] = [];
	for (const match of text.matchAll(pattern)) {
		blocks.push({ body: match[1], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
	}
	return blocks;
}

/**
 * Bare `{"tool": …}` objects written straight into the prose, which is what Manus does on
 * follow-up turns once the fenced example has scrolled out of its own attention.
 *
 * Every `{` that has a tool key within reach is a candidate, and each is then scanned for its
 * matching brace, because a call carries nested objects and strings that a regex cannot balance.
 */
const LOOKAHEAD_CHARS = 400;

function bareCandidates(text: string): { body: string; start: number; end: number }[] {
	const found: { body: string; start: number; end: number }[] = [];
	for (const match of text.matchAll(/\{/g)) {
		const start = match.index ?? 0;
		// A tool key anywhere near the front, not only as the first key: Manus writes
		// `{"arguments": {…}, "tool": "read"}` as readily as the other order.
		if (!/"(?:tool|tool_name)"\s*:/.test(text.slice(start, start + LOOKAHEAD_CHARS))) continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < text.length; index++) {
			const char = text[index];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = !inString;
			if (inString) continue;
			if (char === "{") depth++;
			if (char === "}" && --depth === 0) {
				found.push({ body: text.slice(start, index + 1), start, end: index + 1 });
				break;
			}
		}
	}
	return found;
}

/**
 * Escapes the raw control characters Manus leaves inside a JSON string.
 *
 * A tool call that carries a shell script or a Python snippet is written with real newlines
 * inside the `code` value, which is not valid JSON. Everything outside a string is untouched,
 * so a well-formed call passes through unchanged.
 */
function escapeControlCharsInStrings(body: string): string {
	const escapes: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
	let out = "";
	let inString = false;
	let escaped = false;
	for (const char of body) {
		if (escaped) {
			out += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			out += char;
			escaped = true;
			continue;
		}
		if (char === '"') inString = !inString;
		out += inString && escapes[char] ? escapes[char] : char;
	}
	return out;
}

function asToolCall(body: string, strict = false): ParsedManusToolCall | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.trim());
	} catch {
		try {
			parsed = JSON.parse(escapeControlCharsInStrings(body.trim()));
		} catch {
			return undefined;
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	// Manus does not always use the exact keys asked for, and the intent is unambiguous either way.
	const name = record.tool ?? record.name ?? record.tool_name;
	if (typeof name !== "string" || !name) return undefined;
	const args = record.arguments ?? record.args ?? record.parameters ?? record.input;
	if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return undefined;
	// Outside a fence, `{"name": …}` alone is ordinary JSON far more often than it is a call.
	if (strict && record.tool === undefined && record.tool_name === undefined && args === undefined) return undefined;
	return { name, arguments: (args ?? {}) as Record<string, unknown>, raw: body.trim() };
}

/**
 * Splits a reply into the prose to show and the one tool call to run.
 *
 * The first qualifying block wins. Manus often plans several steps in one reply, and those
 * steps are ordered: running the second one before the first has a result would apply an edit
 * to a file it has not read. Everything after the chosen call is dropped, because it describes
 * work that has not happened; Manus proposes it again on the next turn, with the result in hand.
 */
export function extractManusToolCall(text: string): { text: string; call?: ParsedManusToolCall } {
	const found = (start: number, call: ParsedManusToolCall) => ({ text: text.slice(0, start).trim(), call });

	for (const block of fencedBlocks(text)) {
		const call = asToolCall(block.body);
		if (call) return found(block.start, call);
	}

	for (const candidate of bareCandidates(text)) {
		const call = asToolCall(candidate.body, true);
		if (call) return found(candidate.start, call);
	}

	return { text };
}
