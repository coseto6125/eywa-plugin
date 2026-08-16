/**
 * Manus provider: presents an asynchronous Manus task as an assistant stream.
 *
 * Manus is an autonomous cloud agent rather than a chat model. It has no streaming endpoint,
 * so a turn creates a task (or sends to the live one), polls `task.listMessages`, and forwards
 * each new assistant message as a text delta. That turns Manus's own progress narration into
 * something the TUI renders while the task is still running.
 *
 * The Manus API takes no tool definitions either, so the caller's tools are described in the
 * prompt and a reply asking for one ends the turn with `stopReason: "toolUse"`. The agent runs
 * the tool locally and the result reaches the same task on the next turn.
 */

import { getEnvApiKey } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	latestManusStatusUpdate,
	MANUS_BASE_URL,
	ManusApiError,
	ManusClient,
	type ManusMessage,
	type ManusStatusUpdate,
} from "./manus-client.js";
import { buildManusPromptSlice, manusConversationKey } from "./manus-prompt.js";
import { extractManusToolCall } from "./manus-tool-bridge.js";

/**
 * Provider-specific options for Manus.
 *
 * Everything here has an environment fallback so the built-in provider behaves the same way
 * whether it is driven from the coding agent or from the library directly.
 */
export interface ManusOptions extends StreamOptions {
	/** Poll interval floor and ceiling, in milliseconds. */
	pollIntervalMs?: number;
	maxPollIntervalMs?: number;
	/** Give up on a task that never leaves `running`. */
	taskTimeoutMs?: number;
	/** Manus project to file tasks under, so they do not clutter the personal task list. */
	projectId?: string;
	/** Forward the host's system prompt to Manus. See ManusPromptOptions for why this is off by default. */
	includeSystemPrompt?: boolean;
	/**
	 * Let Manus drive the caller's tools, which is what makes it able to edit the user's
	 * repository instead of only talking about it. On by default when the caller sends tools.
	 */
	bridgeTools?: boolean;
	/** Token ceiling per message sent to Manus. Manus rejects anything over 5000 estimated tokens. */
	maxMessageTokens?: number;
	/** How long a new task may stay unreadable before it is reported as never created. */
	ghostTaskGraceMs?: number;
	/** How long network errors and 5xx are ridden out before the turn fails. */
	transientGraceMs?: number;
	/** Title given to created tasks in the Manus dashboard. */
	taskTitle?: string;
}

interface TaskSession {
	taskId: string;
	/** How many agent messages this task has already been told about. */
	covered: number;
	/**
	 * Manus message ids already forwarded. Ids rather than a timestamp cutoff: Manus stamps
	 * several messages with the same value, and a cutoff drops every one that lands after the
	 * first of them was read.
	 */
	seen: Set<string>;
}

/** Conversation key to live Manus task. Lets a multi-turn chat stay inside one task. */
const sessions = new Map<string, TaskSession>();

/**
 * Cap on remembered conversations. The agent can run as a long-lived daemon, where an
 * unbounded map would keep every conversation it ever saw. Map preserves insertion order,
 * so re-inserting on each use makes the first key the least recently used one.
 */
const MAX_SESSIONS = 100;

function rememberSession(key: string, session: TaskSession): void {
	sessions.delete(key);
	sessions.set(key, session);
	while (sessions.size > MAX_SESSIONS) {
		const oldest = sessions.keys().next().value;
		if (oldest === undefined) break;
		sessions.delete(oldest);
	}
}

/** Exposed for tests; a fresh process starts empty anyway. */
export function resetManusSessions(): void {
	sessions.clear();
}

/** Exposed for tests that need to observe eviction. */
export function manusSessionCount(): number {
	return sessions.size;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 6_000;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;

/** Default window a freshly created task may stay unreadable before it counts as never created. */
const GHOST_TASK_GRACE_MS = 15_000;

/** Default window of network errors and 5xx to ride out before failing the turn. */
const TRANSIENT_GRACE_MS = 60_000;

const DEFAULT_TASK_TITLE = "Eywa Agent";

/**
 * `task.create` can answer with a task id for a task it never creates. Observed for every
 * `agent_profile` except `manus-1.6-lite`, including the `manus-1.6` default: the id comes back
 * with ok:true and then stays unknown to `task.detail` and `task.listMessages` indefinitely.
 * Whether that is specific to some account tiers is unknown, so the message reports the symptom.
 */
function ghostTaskError(taskId: string, profile: string): ManusApiError {
	const hint =
		profile === "manus-1.6-lite"
			? "Check the task at manus.im and the account's credit balance."
			: `Manus does this for every profile except manus-1.6-lite, "${profile}" included. Switch to manus-1.6-lite.`;
	return new ManusApiError(`Manus accepted task ${taskId} but never created it. ${hint}`, 404, "not_found");
}

/**
 * Explains a `waiting` task, which needs an approval the API caller cannot give here.
 *
 * `messageAskUser` is the exception: the agent simply asked a question, its text is already in
 * the reply, and answering on the next turn resumes the task through `task.sendMessage`.
 */
function describeWaiting(update: ManusStatusUpdate, taskId: string): string | undefined {
	const detail = update.status_detail;
	const eventType = detail?.waiting_for_event_type;
	if (!eventType || eventType === "messageAskUser") return undefined;
	const what = detail?.waiting_description ?? eventType;
	return `_Manus is waiting for a confirmation: ${what} (\`${eventType}\`). Approve it at https://manus.im/app/${taskId}, then send another message here to continue._`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Renders one assistant message, including any files Manus built.
 *
 * Attachments arrive as signed CDN links that expire, and the text usually just says
 * "see the attachment", so dropping them loses the actual deliverable.
 */
function renderAssistant(message: ManusMessage): string {
	const body = message.assistant_message;
	// Markdown links, because the TUI renders them (it themes mdLink/mdLinkUrl) and a raw
	// signed CDN URL runs to several hundred characters that would swamp the reply.
	const links = (body?.attachments ?? [])
		.filter((attachment) => attachment.url)
		.map((attachment) => `[${attachment.filename ?? "attachment"}](${attachment.url})`);
	return [body?.content ?? "", links.join("\n")].filter(Boolean).join("\n\n");
}

/** Assistant messages not yet forwarded, oldest first. */
export function newManusAssistantText(messages: ManusMessage[], seen: Set<string>): { text: string; id: string }[] {
	return messages
		.filter((message) => message.type === "assistant_message" && !seen.has(message.id))
		.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
		.map((message) => ({ text: renderAssistant(message), id: message.id }))
		.filter((entry) => entry.text.length > 0);
}

/** Tool bridging is what lets Manus edit the repository. `MANUS_TOOL_BRIDGE=0` gets the plain text model back. */
function bridgeToolsEnabled(options?: ManusOptions): boolean {
	return options?.bridgeTools ?? process.env.MANUS_TOOL_BRIDGE !== "0";
}

export const streamManus: StreamFunction<"manus-tasks", ManusOptions> = (
	model: Model<"manus-tasks">,
	context: Context,
	options?: ManusOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const signal = options?.signal;
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	const client = new ManusClient(apiKey ?? "", model.baseUrl || MANUS_BASE_URL);

	const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const maxPollIntervalMs = options?.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
	const taskTimeoutMs = options?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	const ghostTaskGraceMs = options?.ghostTaskGraceMs ?? GHOST_TASK_GRACE_MS;
	const transientGraceMs = options?.transientGraceMs ?? TRANSIENT_GRACE_MS;
	const projectId = options?.projectId ?? process.env.MANUS_PROJECT_ID;
	const bridgeTools = bridgeToolsEnabled(options);

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let activeTaskId: string | undefined;

		try {
			stream.push({ type: "start", partial: output });

			if (!apiKey) {
				throw new ManusApiError(
					`No API key for provider: ${model.provider}. Set MANUS_API_KEY, or run /login and choose Manus.`,
					401,
				);
			}

			// A Manus task's agent_profile is fixed when it is created, so switching model must start
			// a new task. Without the model in the key, the switch silently keeps talking to the old one.
			const key = `${model.id}::${options?.sessionId ?? manusConversationKey(context)}`;
			const existing = sessions.get(key);
			const slice = buildManusPromptSlice(context, existing?.covered ?? 0, {
				includeSystemPrompt: options?.includeSystemPrompt,
				bridgeTools,
				maxTokens: options?.maxMessageTokens,
			});

			// A follow-up with nothing new to say would leave the task idle forever.
			if (existing && !slice.text) {
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			if (existing) {
				activeTaskId = existing.taskId;
				try {
					await client.sendMessage(existing.taskId, slice.text, signal);
				} catch (error) {
					// The task went away (deleted, or it never really existed). Forget it so the next
					// attempt starts a fresh one instead of retrying against the same dead id.
					if (error instanceof ManusApiError && error.code === "not_found") {
						sessions.delete(key);
						throw new ManusApiError(
							`The Manus task for this conversation (${existing.taskId}) no longer exists. Send the message again to start a new one.`,
							404,
							"not_found",
						);
					}
					throw error;
				}
			} else {
				const created = await client.createTask({
					content: slice.text,
					agentProfile: model.id,
					title: options?.taskTitle ?? DEFAULT_TASK_TITLE,
					projectId,
					hideInTaskList: true,
					signal,
				});
				activeTaskId = created.task_id;
			}
			// Deliberately not cached yet: a task that never becomes readable must not be remembered,
			// or the next turn sends follow-ups to an id that does not exist.
			let sessionCached = false;

			let contentIndex = -1;
			const pushText = (text: string): void => {
				if (contentIndex === -1) {
					output.content.push({ type: "text", text: "" });
					contentIndex = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex, partial: output });
				}
				const block = output.content[contentIndex];
				const delta = block.type === "text" && block.text ? `\n\n${text}` : text;
				if (block.type === "text") block.text += delta;
				stream.push({ type: "text_delta", contentIndex, delta, partial: output });
			};
			// Carried across turns: a follow-up poll returns the whole task history, and only the
			// ids this conversation has not shown yet are new.
			const seen = existing?.seen ?? new Set<string>();
			let interval = pollIntervalMs;
			let unreadableSinceMs = 0;
			let failingSinceMs = 0;
			let waitingNotice: string | undefined;
			let pendingToolCall: ToolCall | undefined;
			const deadline = Date.now() + taskTimeoutMs;

			while (true) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				if (Date.now() > deadline) {
					throw new ManusApiError(`Manus task ${activeTaskId} still running after ${taskTimeoutMs}ms`, 504);
				}

				await sleep(interval, signal);
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

				let messages: ManusMessage[];
				try {
					messages = await client.listMessages(activeTaskId, signal);
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;

					// A brand new task can lag by a poll or two; one that never appears was never created.
					if (error instanceof ManusApiError && error.code === "not_found") {
						unreadableSinceMs ||= Date.now();
						if (Date.now() - unreadableSinceMs >= ghostTaskGraceMs) throw ghostTaskError(activeTaskId, model.id);
						continue;
					}

					// A task can run for minutes. Dropping the answer over one blip wastes the whole run,
					// so ride out network errors and 5xx, while 4xx (bad key, bad request) fails now.
					const transient = !(error instanceof ManusApiError) || error.status >= 500;
					if (!transient) throw error;
					failingSinceMs ||= Date.now();
					if (Date.now() - failingSinceMs >= transientGraceMs) throw error;
					continue;
				}
				unreadableSinceMs = 0;
				failingSinceMs = 0;
				if (!sessionCached) {
					rememberSession(key, { taskId: activeTaskId, covered: slice.covered, seen });
					sessionCached = true;
				}
				const fresh = newManusAssistantText(messages, seen);

				for (const entry of fresh) {
					seen.add(entry.id);
					const { text, call } = bridgeTools
						? extractManusToolCall(entry.text)
						: { text: entry.text, call: undefined };
					if (text) pushText(text);
					if (!call) continue;
					// Manus asked the host to act. The turn ends here; the agent runs the tool and the
					// result reaches the same task on the next turn, so the task keeps its own history.
					pendingToolCall = {
						type: "toolCall",
						id: `manus_${activeTaskId}_${entry.id}`,
						name: call.name,
						arguments: call.arguments,
					};
					break;
				}
				if (pendingToolCall) break;

				// Manus stays responsive right after a burst, so back off only while it is quiet.
				interval = fresh.length > 0 ? pollIntervalMs : Math.min(interval + 1_000, maxPollIntervalMs);

				const update = latestManusStatusUpdate(messages);
				const status = update?.agent_status;
				if (status === "waiting") {
					// Not a finished task: it stopped for an approval. Saying so beats returning a
					// half-answer that looks complete.
					waitingNotice = describeWaiting(update as ManusStatusUpdate, activeTaskId);
					break;
				}
				if (status && status !== "running" && status !== "pending") {
					if (status === "error") {
						output.stopReason = "error";
						output.errorMessage = "Manus reported an error status for this task";
					}
					break;
				}
			}

			if (waitingNotice) pushText(waitingNotice);

			if (contentIndex >= 0) {
				const block = output.content[contentIndex];
				stream.push({
					type: "text_end",
					contentIndex,
					content: block.type === "text" ? block.text : "",
					partial: output,
				});
			}

			if (pendingToolCall) {
				output.content.push(pendingToolCall);
				const toolIndex = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: toolIndex,
					delta: JSON.stringify(pendingToolCall.arguments),
					partial: output,
				});
				stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall: pendingToolCall, partial: output });
				output.stopReason = "toolUse";
			}

			if (output.stopReason === "error") {
				stream.push({ type: "error", reason: "error", error: output });
			} else {
				stream.push({
					type: "done",
					reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
					message: output,
				});
			}
			stream.end();
		} catch (error) {
			const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
			// Leaving a Manus task running after the user hit escape keeps burning credits.
			if (aborted && activeTaskId) await client.stopTask(activeTaskId);
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Manus bills in credits and exposes no thinking levels, so the simple options carry nothing
 * this provider can act on beyond what `StreamOptions` already holds.
 */
export const streamSimpleManus: StreamFunction<"manus-tasks", SimpleStreamOptions> = (
	model: Model<"manus-tasks">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => streamManus(model, context, options as ManusOptions | undefined);
