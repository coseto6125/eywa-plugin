import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The five behaviours this package owns, kept as separate modules so each keeps
// its tests and its history:
import claudeCompat from "./claude-compat/index.ts";
import eywa from "./eywa/index.ts";
import idleGuard from "./idle-guard/index.ts";
import statusline from "./statusline/index.ts";
import toolHooks from "./tool-hooks/index.ts";
import { registerManus } from "./manus/register.ts";

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
# --- await-optional sh (Eywa sync API) ---
try:
    import nest_asyncio as _ep_nest_asyncio
    _ep_nest_asyncio.apply()
except Exception:
    pass
import asyncio as _ep_asyncio
import inspect as _ep_inspect

def _ep_identity(value):
    return value

class _EywaAgentSyncCallResult:
    """Resolved result of an Eywa-owned async call that stays awaitable."""
    __slots__ = ("_eywa_agent_value",)
    def __init__(self, value):
        object.__setattr__(self, "_eywa_agent_value", value)
    def __await__(self):
        yield from ()
        return object.__getattribute__(self, "_eywa_agent_value")
    def __reduce__(self):
        return (_ep_identity, (object.__getattribute__(self, "_eywa_agent_value"),))
    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_eywa_agent_value"), name)
    def __setattr__(self, name, value):
        setattr(object.__getattribute__(self, "_eywa_agent_value"), name, value)
    def __delattr__(self, name):
        delattr(object.__getattribute__(self, "_eywa_agent_value"), name)
    def __dir__(self):
        return dir(object.__getattribute__(self, "_eywa_agent_value"))
    def __repr__(self):
        return repr(object.__getattribute__(self, "_eywa_agent_value"))
    def __str__(self):
        return str(object.__getattribute__(self, "_eywa_agent_value"))
    def __format__(self, spec):
        return format(object.__getattribute__(self, "_eywa_agent_value"), spec)
    def __bool__(self):
        return bool(object.__getattribute__(self, "_eywa_agent_value"))
    def __len__(self):
        return len(object.__getattribute__(self, "_eywa_agent_value"))
    def __iter__(self):
        return iter(object.__getattribute__(self, "_eywa_agent_value"))
    def __contains__(self, item):
        return item in object.__getattribute__(self, "_eywa_agent_value")
    def __getitem__(self, key):
        return object.__getattribute__(self, "_eywa_agent_value")[key]
    def __setitem__(self, key, value):
        object.__getattribute__(self, "_eywa_agent_value")[key] = value
    def __eq__(self, other):
        return object.__getattribute__(self, "_eywa_agent_value") == other
    def __ne__(self, other):
        return object.__getattribute__(self, "_eywa_agent_value") != other
    def __hash__(self):
        return hash(object.__getattribute__(self, "_eywa_agent_value"))
    def __call__(self, *args, **kwargs):
        return object.__getattribute__(self, "_eywa_agent_value")(*args, **kwargs)

def _ep_event_loop():
    try:
        return _ep_asyncio.get_running_loop()
    except RuntimeError:
        pass
    try:
        return _ep_asyncio.get_event_loop()
    except RuntimeError:
        loop = _ep_asyncio.new_event_loop()
        _ep_asyncio.set_event_loop(loop)
        return loop

def _ep_drop_result(future):
    if not future.cancelled():
        future.exception()

def _ep_resolve(awaitable):
    """Run one Eywa coroutine to completion on the kernel loop.
    nest_asyncio (applied above) makes a running loop re-entrant, so this also
    works inside an awaited cell. Without that patch the call reports how to
    fix it instead of blocking the kernel."""
    loop = _ep_event_loop()
    if loop.is_running() and not getattr(loop, "_nest_patched", False):
        close = getattr(awaitable, "close", None)
        if callable(close):
            close()
        raise RuntimeError(
            "This kernel cannot resolve an Eywa API call without await while the event loop runs. "
            "Call it with await instead."
        )
    future = _ep_asyncio.ensure_future(awaitable, loop=loop)
    try:
        return loop.run_until_complete(future)
    except BaseException:
        future.cancel()
        future.add_done_callback(_ep_drop_result)
        raise

def _ep_sync_result(result):
    if type(result) is _EywaAgentSyncCallResult:
        return result
    if not _ep_inspect.isawaitable(result):
        return result
    return _EywaAgentSyncCallResult(_ep_resolve(result))

def _ep_is_async_callable(value):
    if _ep_inspect.iscoroutinefunction(value):
        return True
    call = getattr(type(value), "__call__", None)
    return call is not None and _ep_inspect.iscoroutinefunction(call)

def _ep_await_optional(fn):
    """Return a callable that resolves fn's coroutine; non-async callables pass through."""
    if not _ep_is_async_callable(fn):
        return fn

    @_ep_functools.wraps(fn)
    def _ep_await_optional_call(*args, **kwargs):
        return _ep_sync_result(fn(*args, **kwargs))

    return _ep_await_optional_call

def _ep_make_module_await_optional(module):
    """Make the skill's own async functions await-optional.
    Only callables defined inside the skill package are wrapped, so a
    coroutine function the skill re-exports from a third-party library keeps
    its semantics."""
    package = module.__name__.split(".")[0]
    for name, value in list(vars(module).items()):
        if name.startswith("_"):
            continue
        if getattr(value, "__module__", "").split(".")[0] != package:
            continue
        await_optional = _ep_await_optional(value)
        if await_optional is not value:
            setattr(module, name, await_optional)

try:
    import sh as _ep_sh
    if not getattr(_ep_sh, "_ep_await_optional", False):
        _ep_make_module_await_optional(_ep_sh)
        _ep_sh._ep_await_optional = True
except ImportError:
    pass
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

	// Manus: a custom-stream provider, because the stock runner ships no Manus
	// support at all.
	registerManus(pi);

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
