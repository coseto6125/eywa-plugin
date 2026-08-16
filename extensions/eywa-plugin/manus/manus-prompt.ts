/**
 * Flattens a `Context` into the single text blob a Manus task accepts.
 *
 * The agent resends the whole conversation on every turn; a Manus task keeps its own
 * history. So the first turn ships the full transcript and later turns ship only what
 * the task has not seen yet.
 */

import type { Context, Message } from "@earendil-works/pi-ai";
import {
	estimateManusTokens,
	fitToManusTokens,
	MANUS_MAX_MESSAGE_TOKENS,
	manusToolProtocolPreamble,
	manusToolProtocolReminder,
	renderManusToolCatalog,
} from "./manus-tool-bridge.js";

/**
 * Manus runs in its own cloud sandbox and cannot touch the caller's filesystem. Without
 * this preamble it accepts local-file requests and then narrates work it cannot do.
 * Used when no tools are bridged; with the bridge on, the tool protocol replaces it.
 */
const ENVIRONMENT_PREAMBLE = [
	"You are answering inside a developer's terminal coding agent (Eywa Agent).",
	"You are NOT running on the user's machine. You cannot read, write, or execute anything in their repository,",
	"and any file path they mention does not exist in your sandbox.",
	"Answer from the conversation text alone. When you need file contents you do not have, say so and ask for them.",
	"Skip progress narration; reply with the answer itself.",
].join(" ");

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return "";
				case "toolCall":
					return `[requested tool ${block.name} with ${JSON.stringify(block.arguments)}]`;
				case "image":
					return "[image omitted: Manus tasks take text only through this provider]";
				default:
					return "";
			}
		})
		.filter(Boolean)
		.join("\n");
}

function renderMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `User: ${textOf(message.content)}`;
		case "assistant": {
			const text = textOf(message.content);
			return text ? `Assistant: ${text}` : "";
		}
		case "toolResult": {
			const label = message.isError ? "Tool error" : "Tool result";
			return `${label} (${message.toolName}):\n${textOf(message.content)}`;
		}
		default:
			return "";
	}
}

/** Cost of the `\n\n---\n\n` that joins two sections. */
const SEPARATOR_TOKENS = 3;

/**
 * Keeps the newest messages that fit.
 *
 * The turn's own instruction is the last message, so dropping from the front is what keeps the
 * request intact. A single message too large on its own (a whole-file read) is cut in the middle
 * rather than dropped, since its head and tail are both what Manus asked to see.
 */
function fitTranscript(parts: string[], budget: number): string {
	const kept: string[] = [];
	let used = 0;
	for (let index = parts.length - 1; index >= 0; index--) {
		const remaining = budget - used;
		if (remaining <= 0) {
			kept.unshift("[earlier messages omitted for length]");
			break;
		}
		const part =
			estimateManusTokens(parts[index]) <= remaining ? parts[index] : fitToManusTokens(parts[index], remaining);
		kept.unshift(part);
		used += estimateManusTokens(part) + SEPARATOR_TOKENS;
	}
	return kept.join("\n\n");
}

export interface ManusPromptSlice {
	/** Text to send to Manus for this turn. */
	text: string;
	/** How many of `context.messages` are now covered, to pass back as `alreadySent` next turn. */
	covered: number;
}

export interface ManusPromptOptions {
	/**
	 * Forward the host's system prompt. Off by default: the agent's system prompt describes
	 * its own tool environment, and Manus reads that as an attachment it should open.
	 */
	includeSystemPrompt?: boolean;
	/**
	 * Describe the caller's tools and the calling protocol, so Manus can act on the user's
	 * machine through the host. Off means Manus answers as a text model.
	 */
	bridgeTools?: boolean;
	/** Token ceiling for the whole message. Manus rejects anything over 5000 estimated tokens. */
	maxTokens?: number;
}

/**
 * Builds the text for one turn.
 *
 * @param alreadySent number of leading messages a live Manus task has already been told about;
 *                    0 starts a fresh task and includes the preamble.
 */
export function buildManusPromptSlice(
	context: Context,
	alreadySent = 0,
	options: ManusPromptOptions = {},
): ManusPromptSlice {
	const messages = context.messages ?? [];
	const isFirstTurn = alreadySent === 0;
	// A live task already holds its own replies; echoing them back would double the transcript.
	const pending = isFirstTurn
		? messages
		: messages.slice(alreadySent).filter((message) => message.role !== "assistant");

	const tools = context.tools ?? [];
	const bridging = Boolean(options.bridgeTools) && tools.length > 0;
	const budget = options.maxTokens ?? MANUS_MAX_MESSAGE_TOKENS;

	const sections: string[] = [];
	const spend = (text: string) => {
		sections.push(text);
		return estimateManusTokens(text) + SEPARATOR_TOKENS;
	};

	let used = 0;
	if (isFirstTurn) {
		used += spend(bridging ? manusToolProtocolPreamble() : ENVIRONMENT_PREAMBLE);
	}
	// Reserved before the catalog so the protocol reminder never gets squeezed out by it.
	const reminder = bridging && !isFirstTurn ? manusToolProtocolReminder() : "";
	const reserved = reminder ? estimateManusTokens(reminder) + SEPARATOR_TOKENS : 0;

	if (isFirstTurn && bridging) {
		// Just over half of what is left: the catalog is useless truncated, and so is a transcript
		// cut down to nothing. Both sides get a workable share.
		used += spend(renderManusToolCatalog(tools, Math.floor((budget - used - reserved) * 0.55)));
	}
	if (isFirstTurn && options.includeSystemPrompt && context.systemPrompt) {
		used += spend(`System instructions from the caller:\n${context.systemPrompt}`);
	}

	const transcript = fitTranscript(pending.map(renderMessage).filter(Boolean), budget - used - reserved);
	if (transcript) used += spend(transcript);
	// Restated every turn, and last, because Manus drifts back to plain prose several turns
	// after the protocol was stated at task creation.
	if (reminder) sections.push(reminder);

	return { text: sections.join("\n\n---\n\n"), covered: messages.length };
}

/**
 * Identifies a conversation so follow-up turns reuse the same Manus task.
 * The first user message is stable for the life of a conversation.
 */
export function manusConversationKey(context: Context): string {
	const first = (context.messages ?? []).find((message) => message.role === "user");
	return first ? textOf(first.content).slice(0, 500) : "";
}
