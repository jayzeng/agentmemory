#!/usr/bin/env bash
# Install (or uninstall) agent-memory skills for Claude Code, Codex, Cursor, and Agent CLI.
# Usage: bash scripts/install-skills.sh [--uninstall]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
UNINSTALL=false

if [[ "${1:-}" == "--uninstall" ]]; then
  UNINSTALL=true
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

uninstall_skill() {
  local label="$1"
  local dest_dir="$2"

  if [ -f "$dest_dir/SKILL.md" ]; then
    rm "$dest_dir/SKILL.md"
    rmdir "$dest_dir" 2>/dev/null || true
    echo "Uninstalled $label: $dest_dir/SKILL.md"
  else
    echo "Skipping $label (not installed)"
  fi
}

install_skill() {
  local label="$1"
  local src_dir="$2"
  local dest_dir="$3"
  local home_marker="$4"
  local detect_cmd="${5:-}"

  echo "Detecting $label..."
  if [ ! -d "$home_marker" ]; then
    echo "Not found ($home_marker not found)"
    return
  fi

  if [ -n "$detect_cmd" ] && ! eval "$detect_cmd"; then
    echo "Not found (not detected)"
    return
  fi

  echo "Found"
  if [ -d "$src_dir" ]; then
    mkdir -p "$dest_dir"
    echo "Installing to $dest_dir/SKILL.md"
    cp "$src_dir/SKILL.md" "$dest_dir/SKILL.md"
    echo "Installed $label: $dest_dir/SKILL.md"
  else
    echo "Skipping $label ($src_dir not found)"
  fi
}

SKILL_DIRS=(
  "$HOME/.claude/skills/agent-memory"
  "$HOME/.codex/skills/agent-memory"
  "$HOME/.cursor/skills/agent-memory"
  "$HOME/.agents/skills/agent-memory"
)
SKILL_LABELS=(
  "Claude Code skill"
  "Codex skill"
  "Cursor skill"
  "Agent CLI skill"
)

if $UNINSTALL; then
  echo "Uninstalling agent-memory skills..."
  echo ""
  for i in "${!SKILL_DIRS[@]}"; do
    uninstall_skill "${SKILL_LABELS[$i]}" "${SKILL_DIRS[$i]}"
  done
  echo ""
  echo "Done."
else
  install_skill "Claude Code skill" "$PROJECT_DIR/skills/claude-code" "$HOME/.claude/skills/agent-memory" "$HOME/.claude" '[ -f "$HOME/.claude/settings.json" ] || [ -f "$HOME/.claude/settings.local.json" ] || command_exists claude'
  install_skill "Codex skill" "$PROJECT_DIR/skills/codex" "$HOME/.codex/skills/agent-memory" "$HOME/.codex" '[ -f "$HOME/.codex/config.toml" ] || command_exists codex'
  install_skill "Cursor skill" "$PROJECT_DIR/skills/cursor" "$HOME/.cursor/skills/agent-memory" "$HOME/.cursor"
  install_skill "Agent CLI skill" "$PROJECT_DIR/skills/agent" "$HOME/.agents/skills/agent-memory" "$HOME/.agents"
  echo ""
  echo "Done."
fi
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
