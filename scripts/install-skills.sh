#!/usr/bin/env bash
# Install agent-memory skills for Claude Code, Codex, Cursor, and Agent CLI.
# Usage: bash scripts/install-skills.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

install_skill() {
  local label="$1"
  local src_dir="$2"
  local dest_dir="$3"
  local home_marker="$4"

  if [ ! -d "$home_marker" ]; then
    echo "Skipping $label ($home_marker not found)"
    return
  fi

  if [ -d "$src_dir" ]; then
    mkdir -p "$dest_dir"
    cp "$src_dir/SKILL.md" "$dest_dir/SKILL.md"
    echo "Installed $label: $dest_dir/SKILL.md"
  else
    echo "Skipping $label ($src_dir not found)"
  fi
}

install_skill "Claude Code skill" "$PROJECT_DIR/skills/claude-code" "$HOME/.claude/skills/agent-memory" "$HOME/.claude"
install_skill "Codex skill" "$PROJECT_DIR/skills/codex" "$HOME/.codex/skills/agent-memory" "$HOME/.codex"
install_skill "Cursor skill" "$PROJECT_DIR/skills/cursor" "$HOME/.cursor/skills/agent-memory" "$HOME/.cursor"
install_skill "Agent CLI skill" "$PROJECT_DIR/skills/agent" "$HOME/.agents/skills/agent-memory" "$HOME/.agents"

echo ""
echo "Done."
echo ""
AGENT_MEMORY_BIN="$PROJECT_DIR/dist/agent-memory"
if [ -x "$AGENT_MEMORY_BIN" ]; then
  if [ -d "$HOME/.local/bin" ]; then
    if ln -sf "$AGENT_MEMORY_BIN" "$HOME/.local/bin/agent-memory" 2>/dev/null; then
      echo "Linked agent-memory into: $HOME/.local/bin/agent-memory"
      echo "Ensure $HOME/.local/bin is on your PATH."
    else
      echo "Could not link to $HOME/.local/bin (permissions)."
      echo "Add this to your PATH instead:"
      echo "  $AGENT_MEMORY_BIN"
    fi
  else
    echo "Make sure 'agent-memory' is on your PATH:"
    echo "  $AGENT_MEMORY_BIN"
  fi
else
  echo "Build the CLI binary first:"
  echo "  bun run build:cli"
  echo "Then add it to your PATH:"
  echo "  $AGENT_MEMORY_BIN"
fi
echo ""
echo "Initialize memory: agent-memory init"
