#!/usr/bin/env bash
# Install the learn-with-claude plugin into Codex: MCP server + skills + global AGENTS.md guidance.
# Idempotent: safe to re-run after pulling updates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
CONFIG="$CODEX_HOME/config.toml"
AGENTS="$CODEX_HOME/AGENTS.md"

command -v node >/dev/null || { echo "Node.js 18+ is required." >&2; exit 1; }
mkdir -p "$CODEX_HOME" "$SKILLS_DIR"

# 1. MCP server (absolute path, so it works from any project).
touch "$CONFIG"
if grep -q '^\[mcp_servers\.learn\]' "$CONFIG"; then
  echo "• MCP server 'learn' already in $CONFIG"
else
  printf '\n[mcp_servers.learn]\ncommand = "node"\nargs = ["%s/mcp/server.js"]\n' "$ROOT" >> "$CONFIG"
  echo "✓ Registered MCP server 'learn' in $CONFIG"
fi

# 2. Skills, prefixed so they don't collide with other skills.
for dir in "$ROOT"/skills/*/; do
  name="$(basename "$dir")"
  dest="$SKILLS_DIR/learn-with-claude-$name"
  rm -rf "$dest" && mkdir -p "$dest"
  sed -e "s/^name: $name\$/name: learn-with-claude-$name/" \
      -e 's/learn:teach/learn-with-claude-teach/g; s/learn:review/learn-with-claude-review/g; s/`review` skill/`learn-with-claude-review` skill/g' \
      "$dir/SKILL.md" > "$dest/SKILL.md"
  echo "✓ Skill learn-with-claude-$name -> $dest"
done

# 3. Always-on guidance (Codex has no prompt hooks, so AGENTS.md carries teach mode).
BEGIN="<!-- learn-with-claude:begin -->"; END="<!-- learn-with-claude:end -->"
touch "$AGENTS"
if grep -q "$BEGIN" "$AGENTS"; then
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$AGENTS" > "$AGENTS.tmp" && mv "$AGENTS.tmp" "$AGENTS"
fi
{ echo "$BEGIN"; cat "$ROOT/codex/AGENTS.snippet.md"; echo "$END"; } >> "$AGENTS"
echo "✓ Teach-mode guidance in $AGENTS"

echo
echo "Done. Restart Codex, then try:  \$learn-with-claude-teach add input validation to the signup form"
echo "Dashboard any time:            node \"$ROOT/mcp/cli.js\" dashboard"
