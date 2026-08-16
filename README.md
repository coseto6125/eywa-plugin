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
| `extensions/eywa-plugin` | `%%bash` softening, injected on the first ipython cell |
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
