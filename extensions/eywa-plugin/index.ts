import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The five behaviours this package owns, kept as separate modules so each keeps
// its tests and its history:
import claudeCompat from "./claude-compat/index.ts";
import eywa from "./eywa/index.ts";
import idleGuard from "./idle-guard/index.ts";
import statusline from "./statusline/index.ts";
import toolHooks from "./tool-hooks/index.ts";

// ---------------------------------------------------------------------------
// %%bash softening
//
// Stock Prime Agent turns a non-zero exit from a script magic into
// CalledProcessError, which fails the whole cell and hides the output that
// answered the question. A non-zero exit is the normal answer for grep, ls,
// test and diff, so the wrap below reports the status as an "--- exit N" line
// on stderr and keeps the cell output. It is the same wrap the Eywa fork put
// into its kernel bootstrap; here it is injected as the first ipython cell of
// each session, because the extension API has no kernel-bootstrap hook.
// ---------------------------------------------------------------------------

const SOFTEN_SNIPPET = String.raw`import functools as _ep_functools
import subprocess as _ep_subprocess
import sys as _ep_sys


def _ep_soften_script_magic(original):
    @_ep_functools.wraps(original)
    def soft_script_magic(line, cell, **kwargs):
        try:
            return original(line, cell, **kwargs)
        except _ep_subprocess.CalledProcessError as error:
            print(f"--- exit {error.returncode}", file=_ep_sys.stderr)

    soft_script_magic._ep_softened = True
    return soft_script_magic


def _ep_soften_script_magics():
    manager = getattr(get_ipython(), "magics_manager", None)
    script_magics = manager.registry.get("ScriptMagics") if manager else None
    if script_magics is None:
        return
    cell_magics = manager.magics["cell"]
    for name in script_magics.magics.get("cell", {}):
        original = cell_magics.get(name)
        if original is None or getattr(original, "_ep_softened", False):
            continue
        cell_magics[name] = _ep_soften_script_magic(original)


_ep_soften_script_magics()
`;

/**
 * Make the first ipython cell install the soften wrap, whatever the cell type.
 *
 * A magic cell requires the magic on its first line, so the wrap cannot be
 * prepended to it; the cell is replayed through `run_cell_magic` instead.
 * Python cells get the wrap as a plain prefix. Returns undefined when the
 * caller should leave the cell untouched.
 */
export function softenFirstCell(code: string): string | undefined {
	const trimmed = code.trimStart();
	const magic = /^%%([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*([^\n]*)\n?/.exec(trimmed);
	if (magic) {
		const name = magic[1];
		const line = magic[2];
		const body = trimmed.slice(magic[0].length);
		if (body.includes(`run_cell_magic(${JSON.stringify(name)}`)) {
			return undefined; // already softened
		}
		return [
			SOFTEN_SNIPPET,
			`get_ipython().run_cell_magic(${JSON.stringify(name)}, ${JSON.stringify(line)}, ${JSON.stringify(body)})`,
			"",
		].join("\n");
	}
	if (trimmed.includes("_ep_soften_script_magics")) {
		return undefined; // already softened
	}
	return `${SOFTEN_SNIPPET}${code}`;
}

export default function (pi: ExtensionAPI): void {
	// The five consolidated behaviours, in their original loading order.
	claudeCompat(pi);
	eywa(pi);
	idleGuard(pi);
	statusline(pi);
	toolHooks(pi);

	// %%bash softening: inject once, on the first ipython call of the session.
	let softened = false;
	pi.on("tool_call", (event) => {
		if (softened || event.toolName !== "ipython") return;
		const input = event.input as { code?: string };
		if (!input.code) return;
		const transformed = softenFirstCell(input.code);
		if (transformed === undefined) return;
		input.code = transformed;
		softened = true;
	});
}
