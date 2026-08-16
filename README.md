# eywa-plugin

One installable package that carries the Prime Agent behaviours originally
built inside the Eywa Agent fork, so they run on stock Prime Agent without a
fork. Branding is intentionally out of scope.

## What it ships

| Piece | Origin |
|---|---|
| `extensions/eywa-plugin/index.ts` | one factory composing five extensions |
| `extensions/claude-compat` | Claude Code context files, `@file.md` imports, output style, mechanism map |
| `extensions/eywa` | Eywa session integration helpers |
| `extensions/idle-guard` | idle timeout guard |
| `extensions/statusline` | renders `~/.claude/statusline.sh` inside the TUI |
| `extensions/tool-hooks` | rtk / ecp command rewriting via `tool_call` |
| `extensions/eywa-plugin` | `%%bash` softening + await-optional `sh`, injected on the first ipython cell |
| `extensions/eywa-plugin/manus` | the Manus task-bridge provider (from the fork), registered via `registerProvider` + `streamSimple` |
| `skills/sh` | `sh` skill (run / read / grep), installed to `~/.agents/skills` |

## Install

```bash
./install.sh
```

The extension lands in `~/.prime/agent/extensions/eywa-plugin` and the skill
in `~/.agents/skills/sh`, the Agent Skills standard path that Prime Agent and
other tools read.

## Uninstall

```bash
rm -rf ~/.prime/agent/extensions/eywa-plugin ~/.agents/skills/sh
```

## How the `%%bash` softening works

Stock Prime Agent turns a non-zero exit from `%%bash` into
`CalledProcessError`, which fails the cell and hides the output. The extension
has no kernel-bootstrap hook, so the first ipython cell of each session is
rewritten through the `tool_call` event to install the soften wrap first; the
cell then keeps its output and prints `--- exit N` on stderr.

## Manus

The stock runner ships no Manus support, so the plugin registers it with a
custom `streamSimple` handler that reuses the fork's task bridge
(`task.create` + polling `task.listMessages`, tool bridging through the
prompt). Models: `manus-1.6`, `manus-1.6-lite`, `manus-1.6-max`.

The API key is resolved by the runner at call time: set the `MANUS_API_KEY`
environment variable, or keep the `manus` entry (baseUrl + apiKey) in
`~/.prime/agent/models.json`. Manus tasks run in the cloud and bill credits.

## Verified

Tested headless on stock Prime Agent 0.7.2 (config dir `~/.prime/agent`):

- the merged package loads without errors;
- the `sh` skill is advertised and callable (`await sh.run("pwd")`);
- `sh.run(...)` also works **without** `await`: the call resolves eagerly and
  returns a dual-mode result (`_EywaAgentSyncCallResult`) that behaves like the
  value everywhere and stays awaitable;
- a `%%bash` cell with a failing command returns `--- exit 1` instead of
  `CalledProcessError`;
- a throwaway `streamSimple` provider (dummy echo) streamed a reply through
  the same `registerProvider` path Manus uses;
- `npm test` passes (12 tests).
