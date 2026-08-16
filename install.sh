#!/usr/bin/env bash
# Install the eywa-plugin extension and the sh skill for the current user.
#   extensions -> ~/.prime/agent/extensions/eywa-plugin
#   sh skill   -> ~/.agents/skills/sh  (Agent Skills standard path)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${PRIME_AGENT_DIR:-$HOME/.prime/agent/extensions}"
SKILL_DIR="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"

mkdir -p "$EXT_DIR" "$SKILL_DIR"
rm -rf "$EXT_DIR/eywa-plugin" "$SKILL_DIR/sh"
cp -r "$ROOT/extensions/eywa-plugin" "$EXT_DIR/eywa-plugin"
cp -r "$ROOT/skills/sh" "$SKILL_DIR/sh"
echo "installed: $EXT_DIR/eywa-plugin, $SKILL_DIR/sh"
