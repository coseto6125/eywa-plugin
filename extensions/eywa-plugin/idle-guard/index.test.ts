import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { idleNotice, idleSeconds } from "./index.ts";

// A session with no state file reads as 0 idle, so a fresh session never warns.
{
	assert.equal(idleSeconds(undefined, 1_000_000), 0);
	assert.equal(idleSeconds("", 1_000_000), 0);
	assert.equal(idleSeconds("not-a-number", 1_000_000), 0);
}

// Idle is the gap since the stamp, and never negative when a clock moves back.
{
	assert.equal(idleSeconds("1000", 4300), 3300);
	assert.equal(idleSeconds("5000", 4300), 0);
}

// The notice fires past the threshold only, and carries the gap in minutes.
{
	assert.equal(idleNotice(3300), undefined);
	assert.equal(idleNotice(0), undefined);
	const notice = idleNotice(3600);
	assert.ok(notice?.includes("60"));
	assert.ok(notice?.includes("1h TTL"));
}

// The threshold sits inside the 60-minute cache TTL, so the warning arrives
// before the entry expires rather than after.
{
	assert.equal(idleNotice(3540, 3300)?.includes("59"), true);
	assert.equal(idleNotice(3299, 3300), undefined);
}

describe("idle-guard", () => {
	it("behaves per the fork contract", () => {
		// (top-level assert blocks above run here)
	});
});
