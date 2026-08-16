import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	buildAddendum,
	collectImportClosure,
	findImports,
	stripFrontmatter,
} from "./index.ts";

const dir = mkdtempSync(resolve(tmpdir(), "claude-compat-"));

// findImports: standalone lines only
{
	const content = "# Title\n@RTK.md\ntext → @ECP.md holds the rule\n```\n@FAKE.md\n```\n@sub/OTHER.md\n";
	const found = findImports(content, "/base");
	assert.deepEqual(found, ["/base/RTK.md", "/base/FAKE.md", "/base/sub/OTHER.md"]);
}

// findImports: home-relative and absolute targets
{
	const found = findImports("@~/notes/a.md\n@/etc/b.md\n", "/base");
	assert.equal(found.length, 2);
	assert.ok(found[0].endsWith("/notes/a.md") && !found[0].startsWith("~"));
	assert.equal(found[1], "/etc/b.md");
}

// collectImportClosure: transitive and cycle-safe
{
	writeFileSync(resolve(dir, "a.md"), "A body\n@b.md\n");
	writeFileSync(resolve(dir, "b.md"), "B body\n@a.md\n@c.md\n");
	writeFileSync(resolve(dir, "c.md"), "C body\n");
	const root = { path: resolve(dir, "root.md"), content: "@a.md\n" };
	const closure = collectImportClosure([root]);
	assert.deepEqual(closure.map((f) => f.path), [resolve(dir, "a.md"), resolve(dir, "b.md"), resolve(dir, "c.md")]);
	assert.ok(closure[2].content.includes("C body"));
}

// collectImportClosure: missing target is skipped, not thrown
{
	const closure = collectImportClosure([{ path: resolve(dir, "root.md"), content: "@nope.md\n" }]);
	assert.deepEqual(closure, []);
}

// stripFrontmatter
{
	assert.equal(stripFrontmatter("---\nname: x\n---\nbody\n"), "body\n");
	assert.equal(stripFrontmatter("no frontmatter\n"), "no frontmatter\n");
}

// buildAddendum on the real AGENTS.md: RTK + ECP bodies, output style, mechanism map
{
	const agents = "/home/enor/.prime/agent/AGENTS.md";
	const { readFileSync } = await import("node:fs");
	const addendum = buildAddendum([{ path: agents, content: readFileSync(agents, "utf-8") }]);
	assert.ok(addendum.includes("RTK - Rust Token Killer"), "RTK body missing");
	assert.ok(addendum.includes("ecp find"), "ECP body missing");
	assert.ok(addendum.includes("colleague-in-chat") || addendum.includes("同事"), "output style missing");
	assert.ok(addendum.includes("Claude-to-Prime mechanism map"), "mapping missing");
	assert.ok(!addendum.includes("keep-coding-instructions"), "frontmatter leaked");
	console.log("addendum chars:", addendum.length);
}

console.log("all tests passed");
