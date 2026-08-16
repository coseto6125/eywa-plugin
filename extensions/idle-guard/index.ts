import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Port of ~/.claude/hooks/idle-guard-{submit,stop}.sh to a Pi extension.
// An Anthropic prompt cache entry lives 60 minutes. A turn sent after that window
// pays the full uncached price, and nothing in the UI says so. This warns first.
//
// The Claude hook blocks the submission so the user resubmits into a warm path.
// `before_agent_start` cannot block, so this notifies instead: the turn runs, and
// the user learns why it is slow while it runs. The notice never reaches the model.

const IDLE_THRESHOLD_S = 3300; // 55 min, inside the 60-minute cache TTL
// State lives under the user's own directory, never a world-writable /tmp path:
// the session id falls back to "default", which a shared path would let any local
// account pre-empt with a symlink.
const STATE_DIR = resolve(process.env.XDG_RUNTIME_DIR ?? resolve(homedir(), ".cache"), "prime-idle-guard");

/** Seconds since the last recorded activity. A session with no file reads as 0. */
export function idleSeconds(last: string | undefined, now: number): number {
	const stamp = Number.parseInt(last ?? "", 10);
	return Number.isFinite(stamp) ? Math.max(0, now - stamp) : 0;
}

/** The warning shown to the user, or undefined while the cache is still warm. */
export function idleNotice(idle: number, threshold = IDLE_THRESHOLD_S): string | undefined {
	if (idle <= threshold) return undefined;
	return `⏸ 已閒置約 ${Math.floor(idle / 60)} 分鐘，prompt cache (1h TTL) 可能已冷，這一輪會是未快取的慢回合。`;
}

export default function (pi: ExtensionAPI) {
	const stateFile = (id: string) => resolve(STATE_DIR, `${id || "default"}.last`);

	const touch = (id: string) => {
		try {
			mkdirSync(STATE_DIR, { recursive: true });
			writeFileSync(stateFile(id), String(Math.floor(Date.now() / 1000)));
		} catch {
			// A guard that cannot write its own state stays silent rather than failing a turn.
		}
	};

	const read = (id: string): string | undefined => {
		try {
			return readFileSync(stateFile(id), "utf8");
		} catch {
			return undefined;
		}
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		const id = ctx.sessionManager?.getSessionId?.() ?? "default";
		const notice = idleNotice(idleSeconds(read(id), Math.floor(Date.now() / 1000)));
		// Stamp before the notice, so a resubmit measures ~0 idle and stays quiet.
		touch(id);
		if (notice) ctx.ui.notify(notice, "warning");
	});

	// A long agentic turn keeps the cache warm past the original submit, so the
	// turn's end is the honest activity time.
	pi.on("turn_end", async (_event, ctx) => {
		touch(ctx.sessionManager?.getSessionId?.() ?? "default");
	});
}
