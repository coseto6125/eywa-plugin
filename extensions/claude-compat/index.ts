import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Claude Code expands `@file.md` inside CLAUDE.md; Pi reads context files verbatim
// (core/resource-loader.js loadContextFileFromDir). This extension restores the
// imported bodies, adds the Claude output style, and states which Claude-only
// mechanisms map to which Prime Agent ones. The Claude side stays untouched.

const OUTPUT_STYLE_PATH = resolve(homedir(), ".claude/output-styles/colleague-zh.md");
const MAX_IMPORT_DEPTH = 5;
const IMPORT_LINE = /^[ \t]*@([^\s@][^\s]*\.md)[ \t]*$/;

export interface ContextFile {
	path: string;
	content: string;
}

/** Absolute paths of standalone `@file.md` import lines, in file order. */
export function findImports(content: string, baseDir: string): string[] {
	const found: string[] = [];
	for (const line of content.split("\n")) {
		const match = IMPORT_LINE.exec(line);
		if (!match) continue;
		const raw = match[1];
		const target = raw.startsWith("~/")
			? resolve(homedir(), raw.slice(2))
			: isAbsolute(raw)
				? raw
				: resolve(baseDir, raw);
		if (!found.includes(target)) found.push(target);
	}
	return found;
}

/** Depth-first import closure of `files`, cycle-safe and de-duplicated. */
export function collectImportClosure(files: readonly ContextFile[]): ContextFile[] {
	const collected: ContextFile[] = [];
	const seen = new Set(files.map((file) => file.path));
	const walk = (content: string, baseDir: string, depth: number): void => {
		if (depth > MAX_IMPORT_DEPTH) return;
		for (const target of findImports(content, baseDir)) {
			if (seen.has(target) || !existsSync(target)) continue;
			seen.add(target);
			const imported = readFileSync(target, "utf-8");
			collected.push({ path: target, content: imported });
			walk(imported, dirname(target), depth + 1);
		}
	};
	for (const file of files) walk(file.content, dirname(file.path), 1);
	return collected;
}

/** Body of a Markdown file with its YAML frontmatter removed. */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	return end === -1 ? content : content.slice(content.indexOf("\n", end + 1) + 1);
}

const HARNESS_MAPPING = `## Claude-to-Prime mechanism map

The context files above are shared with Claude Code, where some mechanisms have other names.
Read every rule that names one of these through its Prime Agent equivalent.

| Rule text says | Here it is |
|---|---|
| Task tool, \`subagent_type: lite-scan\`/\`deep-review\`, "dispatch a sub-agent" | \`handle = await rlm('task', name='...')\` in IPython, with the role and the read-only limits written into the task prompt |
| \`mcp__exec__run\` and other \`mcp__*\` tools | no MCP here; run the same query through its own CLI or the IPython kernel |
| a slash command such as \`/simplify\` | the skill of that name: read its SKILL.md and follow it |
| an output style | the style block below governs user-facing prose |
| Read/Grep/Glob/Edit/Bash tools | the IPython kernel, \`%%bash\` cells, and the \`edit\` skill |

Dispatch policy, model tiers, and effort levels keep their meaning; only the launch mechanism changes.`;

/** Full system-prompt addendum: imported context bodies, output style, mechanism map. */
export function buildAddendum(contextFiles: readonly ContextFile[]): string {
	const sections: string[] = [];
	for (const file of collectImportClosure(contextFiles)) {
		sections.push(`## Imported by context file: ${file.path}\n\n${file.content.trim()}`);
	}
	if (existsSync(OUTPUT_STYLE_PATH)) {
		const style = stripFrontmatter(readFileSync(OUTPUT_STYLE_PATH, "utf-8")).trim();
		sections.push(`## Output style: colleague-zh (${OUTPUT_STYLE_PATH})\n\n${style}`);
	}
	sections.push(HARNESS_MAPPING);
	return sections.join("\n\n---\n\n");
}

/** Signature over the files the addendum is built from, for cache invalidation. */
function signature(contextFiles: readonly ContextFile[]): string {
	const paths = [
		...collectImportClosure(contextFiles).map((file) => file.path),
		OUTPUT_STYLE_PATH,
	];
	const stamps = paths.map((path) => {
		try {
			return `${path}:${statSync(path).mtimeMs}`;
		} catch {
			return `${path}:missing`;
		}
	});
	return [...contextFiles.map((file) => `${file.path}:${file.content.length}`), ...stamps].join("|");
}

export default function (pi: ExtensionAPI) {
	let cached: { key: string; addendum: string } | undefined;

	pi.on("before_agent_start", (event) => {
		const contextFiles = event.systemPromptOptions?.contextFiles ?? [];
		if (contextFiles.length === 0) return;
		const key = signature(contextFiles);
		if (cached?.key !== key) cached = { key, addendum: buildAddendum(contextFiles) };
		if (cached.addendum.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${cached.addendum}` };
	});

	pi.registerCommand("claude-compat", {
		description: "Show the Claude compatibility addendum added to the system prompt",
		handler: async (_args, ctx) => {
			const files = [{ path: resolve(homedir(), ".prime/agent/AGENTS.md"), content: "" }];
			const loaded = files
				.filter((file) => existsSync(file.path))
				.map((file) => ({ path: file.path, content: readFileSync(file.path, "utf-8") }));
			ctx.ui.notify(buildAddendum(loaded).slice(0, 4000), "info");
		},
	});
}
