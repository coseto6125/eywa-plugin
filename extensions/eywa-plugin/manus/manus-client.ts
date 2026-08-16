/**
 * Minimal client for the Manus Agent API v2.
 *
 * Manus is an asynchronous agent: `task.create` returns a task id immediately and
 * the work happens server-side. Progress is read by polling `task.listMessages`.
 * There is no streaming endpoint.
 */

export const MANUS_BASE_URL = "https://api.manus.ai";

/** The documented API-key header. `Authorization: Bearer` is for OAuth tokens and rejects an API key. */
const API_KEY_HEADER = "x-manus-api-key";

export type ManusAgentStatus = "running" | "pending" | "waiting" | "stopped" | "completed" | "error";

/** Present when `agent_status` is `waiting`: what the agent needs before it can continue. */
export interface ManusStatusDetail {
	waiting_for_event_id?: string;
	waiting_for_event_type?: string;
	waiting_description?: string;
	confirm_input_schema?: Record<string, unknown>;
}

export interface ManusStatusUpdate {
	agent_status: ManusAgentStatus;
	brief?: string;
	description?: string;
	status_detail?: ManusStatusDetail;
}

/** A file Manus produced in its sandbox, offered as a time-limited signed CDN URL. */
export interface ManusAttachment {
	type?: string;
	filename?: string;
	content_type?: string;
	url?: string;
}

export interface ManusMessage {
	id: string;
	timestamp: string;
	type: "user_message" | "assistant_message" | "status_update" | "structured_output_result" | string;
	user_message?: { content: string; message_type?: string };
	assistant_message?: { content: string; attachments?: ManusAttachment[] };
	status_update?: ManusStatusUpdate;
	structured_output_result?: { success: boolean; value?: unknown };
}

export interface ManusCreateTaskResult {
	ok: boolean;
	task_id: string;
	task_title?: string;
	task_url?: string;
}

export interface ManusCreateTaskOptions {
	content: string;
	agentProfile: string;
	title?: string;
	projectId?: string;
	hideInTaskList?: boolean;
	/**
	 * JSON Schema for a structured reply. Manus enforces OpenAI strict-mode rules:
	 * every object needs `additionalProperties: false` and a `required` array listing
	 * every one of its properties. A schema that breaks either rule is rejected with
	 * `invalid_argument` at task creation.
	 */
	structuredOutputSchema?: Record<string, unknown>;
	signal?: AbortSignal;
}

export class ManusApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly requestId?: string,
	) {
		super(message);
		this.name = "ManusApiError";
	}
}

export class ManusClient {
	constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string = MANUS_BASE_URL,
	) {}

	private async request<T>(
		path: string,
		init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: init.method,
			headers: {
				[API_KEY_HEADER]: this.apiKey,
				"Content-Type": "application/json",
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: init.signal,
		});

		const text = await response.text();
		let payload: any;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new ManusApiError(
				`Manus returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
				response.status,
			);
		}

		if (!response.ok || payload?.ok === false) {
			const error = payload?.error ?? {};
			throw new ManusApiError(
				error.message ?? `Manus request failed with ${response.status}`,
				response.status,
				error.code,
				payload?.request_id,
			);
		}
		return payload as T;
	}

	createTask(options: ManusCreateTaskOptions): Promise<ManusCreateTaskResult> {
		return this.request<ManusCreateTaskResult>("/v2/task.create", {
			method: "POST",
			signal: options.signal,
			body: {
				message: { content: options.content },
				agent_profile: options.agentProfile,
				...(options.title ? { title: options.title } : {}),
				...(options.projectId ? { project_id: options.projectId } : {}),
				...(options.hideInTaskList ? { hide_in_task_list: true } : {}),
				...(options.structuredOutputSchema ? { structured_output_schema: options.structuredOutputSchema } : {}),
			},
		});
	}

	sendMessage(taskId: string, content: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
		return this.request("/v2/task.sendMessage", {
			method: "POST",
			signal,
			body: { task_id: taskId, message: { content } },
		});
	}

	/** Returns messages newest-first, the order the API itself uses. */
	async listMessages(taskId: string, signal?: AbortSignal): Promise<ManusMessage[]> {
		const payload = await this.request<{ messages?: ManusMessage[] }>(
			`/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}`,
			{ method: "GET", signal },
		);
		return payload.messages ?? [];
	}

	/** Credit balance for the key's caller. Cheap, so it doubles as an API-key check. */
	availableCredits(signal?: AbortSignal): Promise<{ total_credits?: number; free_credits?: number }> {
		return this.request("/v2/usage.availableCredits", { method: "GET", signal });
	}

	async stopTask(taskId: string): Promise<void> {
		// Best-effort: abandoning a task must never mask the original abort.
		await this.request("/v2/task.stop", { method: "POST", body: { task_id: taskId } }).catch(() => undefined);
	}
}

/** Reads the newest status update, which is what decides whether a task is still working. */
export function latestManusStatusUpdate(messages: ManusMessage[]): ManusStatusUpdate | undefined {
	for (const message of messages) {
		if (message.type === "status_update" && message.status_update) return message.status_update;
	}
	return undefined;
}

export function latestManusAgentStatus(messages: ManusMessage[]): ManusAgentStatus | undefined {
	return latestManusStatusUpdate(messages)?.agent_status;
}
