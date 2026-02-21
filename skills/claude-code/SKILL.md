---
name: agent-memory
description: Persistent memory across coding sessions — long-term facts, daily logs, scratchpad checklist, and semantic search.
allowed-tools: Bash(agent-memory *)
---

# Agent Memory

You have a persistent memory system. Use it to remember decisions, preferences, lessons learned, and context across sessions.

## Current Memory Context

!`agent-memory context --no-search 2>/dev/null`

## Memory Commands

All commands use the `agent-memory` CLI. Examples:

### Write to memory

```bash
# Save a long-term fact, decision, or preference
agent-memory write --target long_term --content "User prefers TypeScript with strict mode"

# Overwrite MEMORY.md entirely (use with care)
agent-memory write --target long_term --content "..." --mode overwrite

# Append to today's daily log
agent-memory write --target daily --content "Fixed auth bug in login.ts — was missing token refresh"
```

### Read memory

```bash
# Read long-term memory
agent-memory read --target long_term

# Read today's daily log
agent-memory read --target daily

# Read a specific day's log
agent-memory read --target daily --date 2026-02-15

# List all daily logs
agent-memory read --target list

# Read scratchpad
agent-memory read --target scratchpad
```

### Manage scratchpad (checklist)

```bash
# Add an item
agent-memory scratchpad add --text "Review PR #42"

# List items
agent-memory scratchpad list

# Mark item as done (matches by substring)
agent-memory scratchpad done --text "PR #42"

# Undo a done item
agent-memory scratchpad undo --text "PR #42"

# Remove all completed items
agent-memory scratchpad clear_done
```

### Search memory (requires qmd)

```bash
# Fast keyword search
agent-memory search --query "database choice" --mode keyword

# Semantic search (finds related concepts)
agent-memory search --query "how do we handle auth" --mode semantic

# Deep hybrid search with reranking
agent-memory search --query "performance optimization" --mode deep --limit 10
```

### Setup and status

```bash
# Initialize memory directory and qmd collection
agent-memory init

# Show configuration and status
agent-memory status
```

## Guidelines

- When someone says "remember this" or asks you to note something, write it immediately using `agent-memory write`
- Use `--target long_term` for durable facts: decisions, preferences, architecture choices, lessons learned
- Use `--target daily` for session notes: what you worked on, bugs found, progress updates
- Use the scratchpad for TODOs, follow-ups, and things to keep in mind
- Use `#tags` (e.g. `#decision`, `#preference`, `#lesson`) and `[[links]]` (e.g. `[[auth-strategy]]`) in content to improve future search recall
- Before starting a task, check if relevant context exists via `agent-memory search`
- At the end of a significant work session, summarize what was done in the daily log
