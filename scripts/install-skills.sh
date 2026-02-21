#!/usr/bin/env bash
# Install agent-memory skills for Claude Code and Codex CLI.
# Usage: bash scripts/install-skills.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Claude Code skill
CLAUDE_SKILL_DIR="$HOME/.claude/skills/agent-memory"
if [ -d "$PROJECT_DIR/skills/claude-code" ]; then
  mkdir -p "$CLAUDE_SKILL_DIR"
  cp "$PROJECT_DIR/skills/claude-code/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"
  echo "Installed Claude Code skill: $CLAUDE_SKILL_DIR/SKILL.md"
else
  echo "Skipping Claude Code skill (skills/claude-code/ not found)"
fi

# Codex skill
CODEX_SKILL_DIR="$HOME/.codex/skills/agent-memory"
if [ -d "$PROJECT_DIR/skills/codex" ]; then
  mkdir -p "$CODEX_SKILL_DIR"
  cp "$PROJECT_DIR/skills/codex/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"
  echo "Installed Codex skill: $CODEX_SKILL_DIR/SKILL.md"
else
  echo "Skipping Codex skill (skills/codex/ not found)"
fi

echo ""
echo "Done. Make sure 'agent-memory' is on your PATH:"
echo "  npm install -g agent-memory   # or: bun run build:cli && ln -s dist/agent-memory /usr/local/bin/"
echo ""
echo "Initialize memory: agent-memory init"
