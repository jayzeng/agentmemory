---
name: agent-memory
description: Persistent memory across coding sessions — long-term facts, daily logs, topic notes, scratchpad checklist, and semantic search.
allowed-tools: Bash(agent-memory *)
---

# Agent Memory

You have a persistent memory system. Use it **proactively** — don't wait to be asked.

Pi users can choose the native extension (`pi-memory`: https://github.com/jayzeng/pi-memory) or use this CLI + skill workflow as the cross-platform alternative.

## Current Memory Context

!`agent-memory context --no-search 2>/dev/null`

## Session Lifecycle

### On session start
1. Review the memory context above — especially **open scratchpad items** (pick up where you left off)
2. If the user's task relates to prior work, search for relevant memories:
   ```bash
   agent-memory search --query "<topic>" --mode keyword
   ```

### On session end (after significant work)
1. Log what was accomplished in the daily log
2. Mark completed scratchpad items as done; add new follow-ups
3. Only write to long-term memory if you discovered a **durable fact** that doesn't already exist there

## Where to Write — Decision Guide

**Default to daily. Long-term is rare.**

| What happened | Write to | Why |
|---|---|---|
| Made progress, fixed a bug, investigated something | `daily` | Session-specific — searchable later via qmd |
| Tracking a topic or event across days | `topic` | Builds a per-topic file with backlinks to daily logs |
| User said "remember this" about a preference or decision | `long_term` | Durable fact, needs to be in every session's context |
| Discovered a recurring pattern (3rd time seeing it) | `long_term` | Graduated from daily observations to established fact |
| Found a gotcha, workaround, or non-obvious behavior | `daily` first | If it keeps coming up, *then* promote to long-term |
| TODO or follow-up for any task (persistent todo) | `scratchpad` | Persistent, cross-session task tracking |

**MEMORY.md is a curated wiki, not a log.** It should stay under ~50 lines of high-signal content. If you're appending to it frequently, you're probably writing to the wrong target.

## Memory Commands

### Write to daily log (default — no --target needed)

```bash
# Session notes, progress, bugs found, decisions made
agent-memory write --content "Fixed auth bug in login.ts — token refresh was missing"
agent-memory write --content "Investigated slow queries — N+1 in getUserOrders, added .include(:orders)"
```

### Write to long-term memory (rare, curated)

```bash
# Only for durable facts that belong in every session's context
agent-memory write --target long_term --content "Project uses Drizzle ORM with PostgreSQL. Migrations in db/migrations/. #architecture"

# Overwrite MEMORY.md entirely (for curation — rewrite, don't append)
agent-memory write --target long_term --content "..." --mode overwrite
```

When writing to long-term, prefer **overwrite mode** to curate the whole file rather than blindly appending. Read it first, then rewrite with the new fact incorporated.

### Write to a topic/event file

```bash
# Event- or theme-based log with backlinks to the daily entry
agent-memory write --target topic --topic "auth" --content "JWT refresh rolled out to edge #auth"
```

### Read

```bash
agent-memory read --target daily             # Today's log
agent-memory read --target daily --date 2026-02-15  # Specific day
agent-memory read --target list              # All daily log files
agent-memory read --target topic --topic "auth"
agent-memory read --target topics            # All topic files
agent-memory read --target long_term         # MEMORY.md
agent-memory read --target scratchpad        # Scratchpad checklist
```

### Scratchpad (persistent TODOs)

```bash
agent-memory scratchpad add --text "Review PR #42"
agent-memory scratchpad list
agent-memory scratchpad done --text "PR #42"       # Matches by substring
agent-memory scratchpad undo --text "PR #42"
agent-memory scratchpad clear_done                  # Remove completed items
```

### Search — recall past work

Search is how you find things written to daily logs. Use it before duplicating effort.

```bash
agent-memory search --query "database choice" --mode keyword    # Fast keyword
agent-memory search --query "how we handle auth" --mode semantic # Finds related concepts
agent-memory search --query "performance" --mode deep --limit 10 # Hybrid + reranking
```

If qmd is not installed, fall back to reading files directly:
```bash
agent-memory read --target long_term
agent-memory read --target daily
```

### Setup

```bash
agent-memory init      # Create dirs, detect qmd, setup collection
agent-memory sync      # Re-index and embed all files (requires qmd)
agent-memory status    # Show config, file counts, qmd status
```

## Writing Good Entries

### Daily log entries
Describe what you did and what you learned. Include `#tags` — distil uses them to organize MEMORY.md.

**Recommended tags** (use what fits, invent your own as needed):
`#architecture` `#auth` `#bugfix` `#database` `#deploy` `#docs` `#ops` `#perf` `#refactor` `#security` `#testing` `#ui`

```bash
# Good — specific, searchable, tagged
agent-memory write --content "Refactored auth middleware to use jose instead of jsonwebtoken. Reduced bundle by 40KB. #refactor #auth"

# Bad — too vague, no tags
agent-memory write --content "worked on auth stuff"
```

### Long-term entries
Only facts that should appear in **every** session's context. Use `#tags` and `[[links]]`.

```bash
# Good — this belongs in every session
agent-memory write --target long_term --content "Deploy: 'bun run deploy:prod', requires AWS_PROFILE=prod. #ops [[deploy]]"

# Bad — this is a daily log entry, not a durable fact
agent-memory write --target long_term --content "Fixed the deploy script today"
```

## Memory Hygiene

- **Daily is the default** — when in doubt, write to daily (no `--target` needed)
- **MEMORY.md is a wiki** — curate it by reading + rewriting, not by appending endlessly
- **Keep MEMORY.md under ~50 lines** — it's injected into every session, so only high-signal facts belong there
- **Search before writing long-term** — the fact may already exist in a daily log, searchable via qmd
- **Promote deliberately** — if a pattern appears in daily logs 3+ times, that's when it earns a spot in MEMORY.md
- **Distil periodically** — run `agent-memory distil` to auto-generate a compact tagged index in MEMORY.md from daily logs and topics

### Distil — auto-curate MEMORY.md

```bash
agent-memory distil --dry-run   # Preview without writing
agent-memory distil             # Overwrite MEMORY.md with distilled index
```

Distil scans daily logs and topic notes, groups entries by their `#tags`, and generates a compact MEMORY.md with tag-based sections, a topic index, and a tag index. Any `## Pinned` section in the existing MEMORY.md is preserved. The more consistently you tag entries, the better the distilled output.

## Guidelines

- When someone says "remember this", decide: is it a durable fact (long-term) or a session note (daily)?
- Default to daily for almost everything (just `--content "..."` — no `--target` needed)
- Use `--target long_term` sparingly: architecture, preferences, key commands, hard-won lessons
- Prefer the scratchpad for any TODOs or follow-ups (persistent, cross-session tracking)
- Use `#tags` and `[[links]]` in content to improve search recall
- Use `agent-memory search` to recall past work before starting related tasks
