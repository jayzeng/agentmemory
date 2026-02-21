# agent-memory: Designing Memory for Coding Agents

## The Problem

Coding agents lose everything when the context window resets. A decision made in
hour one ("we chose PostgreSQL because of JSON support") is gone by hour three.
The agent re-asks questions, contradicts past choices, and fails to build on its
own history.

Most memory systems try to solve this with vector databases, knowledge graphs, or
specialized retrieval architectures. We took a different approach: plain markdown
files, full-text search, and a few well-placed injection points.

This document explains why.

## Prior Art: What the Benchmarks Show

Letta (formerly MemGPT) published "Benchmarking AI Agent Memory: Is a Filesystem
All You Need?" (August 2025), evaluating memory architectures on the LoCoMo
benchmark — a question-answering task over long conversations.

Results on the two systems tested:

```
    Letta (filesystem + search tools)  :  74.0%  (GPT-4o mini)
    Mem0 (graph-based memory)          :  68.5%
```

Only these two systems were compared. The benchmark measures retrieval accuracy,
not broader agentic memory capabilities. But the finding is worth noting:

> "Agents today are highly effective at using tools, especially those likely
>  to have been in their training data (such as filesystem operations)."
>  — Letta, Aug 2025

The key insight: LLMs are already good at `grep`, `search`, `open`, `close`.
They can iteratively rephrase queries and navigate file trees. A purpose-built
vector index doesn't necessarily outperform an agent with access to filesystem
tools it already knows how to use.

**Caveat:** This is one benchmark, two systems, one task type. We cite it as
motivation, not proof.

## Design Philosophy

Three principles guided the design:

**1. Files are the index.**
No separate metadata store, no extraction pipeline, no sync to keep in
agreement. Memory lives in `~/.agent-memory/` as markdown files. qmd
(a full-text + vector search tool) indexes them directly. `git diff` shows
what changed. `cat` shows what's stored.

**2. Injection should be selective, not exhaustive.**
The previous design injected ALL of MEMORY.md every turn, truncating from
the middle when it exceeded limits. This meant early decisions got silently
dropped as memory grew. The new design searches for memories relevant to
the current prompt and injects those alongside a smaller MEMORY.md window.

**3. Fail gracefully, always.**
Every qmd-dependent feature has a timeout and a fallback. If qmd is missing,
the CLI and skills work with plain file reads. If search times out, injection
falls back to the previous behavior. No feature is critical-path.

## Architecture

```
                              +------------------+
                              |   User Prompt    |
                              +--------+---------+
                                       |
                          +------------v-------------+
                          |   Context injection      |
                          |                          |
                          |  1. searchRelevantMemories(prompt)
                          |     - sanitize prompt    |
                          |     - qmd search (3s timeout)
                          |     - format top 3 results
                          |                          |
                          |  2. buildMemoryContext(searchResults)
                          |     - read scratchpad    |
                          |     - read today's daily |
                          |     - include search results
                          |     - read MEMORY.md     |
                          |     - read yesterday's daily
                          |     - truncate to 16K    |
                          |                          |
                          |  3. Append to system prompt
                          +------------+-------------+
                                       |
                              +--------v---------+
                              |   Agent Turn     |
                              |                  |
                              |  Tools available:|
                              |  - memory_write  |
                              |  - memory_read   |
                              |  - scratchpad    |
                              |  - memory_search |
                              +--------+---------+
                                       |
                              +--------v---------+
                              |  After writes:   |
                              |  debounced       |
                              |  qmd update      |
                              |  (500ms, async)  |
                              +------------------+
```

Context injection is triggered by the skill's inline directive (`!`agent-memory
context --no-search``) in Claude Code, or by explicit CLI invocation in other
agents (Codex, Cursor, generic agent).

### Injection Priority

Context budget is 16K chars. Sections are built in priority order; when the total
exceeds the budget, the assembled output is truncated from the start:

```
  Priority    Section                      Budget    Truncation
  --------    -------                      ------    ----------
  1 (high)    Open scratchpad items        2.0K      from start
  2           Today's daily log            3.0K      from end (tail)
  3           qmd search results           2.5K      from start
  4           MEMORY.md (long-term)        4.0K      from middle
  5 (low)     Yesterday's daily log        3.0K      from end (tail)
                                          ------
                                          14.5K (individual caps)
                                          16.0K (total cap)
```

The gap between individual caps (14.5K) and total cap (16K) provides headroom
for section headers and separator lines.

### Why This Order

Scratchpad first because it represents active work items — things the agent was
told to keep in mind. Today's log next because it's the running record of the
current session. Search results third because they're the system's best guess at
what's relevant to the current prompt. MEMORY.md fourth because it's curated but
may contain entries unrelated to the current task. Yesterday last because it's
the oldest context and most likely to be stale.

### Selective Injection Flow

```
  User: "what database should we use?"
         |
         v
  searchRelevantMemories("what database should we use?")
         |
         +-- sanitize: strip control chars, limit to 200 chars
         +-- check: qmd available? collection exists?
         +-- qmd search "what database should we use?" -n 3 -c agent-memory
         +-- timeout: 3 seconds (Promise.race)
         +-- format: markdown snippets with file paths
         |
         v
  Result: "#decision [[database-choice]] Chose PostgreSQL for all
           backend services. Evaluated MySQL and MongoDB..."
         |
         v
  Injected into system prompt under "## Relevant memories (auto-retrieved)"
```

The agent sees the relevant memory without calling any tool. If qmd is down or
the search returns nothing, this section is simply absent — no error, no delay
beyond the 3-second timeout.

### Tags and Links

```markdown
  #decision [[database-choice]] Chose PostgreSQL for all backend services.
  #preference [[editor]] User prefers Neovim with LazyVim config.
  #lesson [[api-versioning]] URL prefix versioning avoids CDN cache issues.
```

These are content conventions, not enforced metadata. qmd's BM25 keyword search
indexes them as regular text. Searching for `#decision` or `database-choice`
finds entries containing those strings. No extraction code, no tag registry, no
schema to maintain.

This is deliberately low-tech. Tags work because full-text search works. If a
user never uses tags, everything still functions — the content itself is
searchable.

### qmd Auto-Setup

Previous versions required manual `qmd collection add` and `qmd context add`
commands. Now:

```
  CLI init / first search
       |
       +-- detectQmd() — runs `qmd status` (5s timeout)
       |     no  --> show install instructions, stop
       |     yes --> continue
       |
       +-- checkCollection("agent-memory") — `qmd collection list --json` (10s timeout)
       |     yes --> done
       |     no  --> setupQmdCollection()
       |               |
       |               +-- qmd collection add ~/.agent-memory --name agent-memory
       |               +-- qmd context add /daily "Daily work logs" -c agent-memory
       |               +-- qmd context add / "Long-term memory" -c agent-memory
       |               |
       |               +-- any step fails? log and continue (not critical)
       |
       done
```

The same auto-setup runs inside the `memory_search` tool if the collection is
missing at search time, covering the case where qmd was installed mid-session.

### Search Modes

The `memory_search` tool supports three modes, each mapping to a different qmd
command:

```
  Mode        qmd command   Use case
  --------    -----------   --------
  keyword     search        Fast BM25 lookup (~30ms). Default.
  semantic    vsearch       Vector similarity when wording differs from stored text.
  deep        query         LLM-powered query for complex questions. Slowest.
```

Default limit is 5 results. All modes use `--json -c agent-memory` and have a
60-second timeout. Selective injection always uses keyword mode with limit 3 and
a tighter 3-second timeout.

## What We Chose Not to Build

**No separate index file.** Tags, links, and entry metadata live in the content.
qmd indexes content directly. A parallel index would need sync logic, conflict
resolution, and schema maintenance — complexity that buys nothing over full-text
search.

**No knowledge graph.** The Letta benchmark suggests graphs don't necessarily
outperform filesystem search for LLM agents. A graph requires entity extraction,
relationship modeling, and query translation — all failure-prone. Wiki-links like
`[[database-choice]]` achieve cross-referencing through content, searchable
without any graph infrastructure.

**No multiple collections.** One qmd collection with path contexts (`/daily` vs
`/`) is sufficient. Splitting into per-topic collections would require routing
logic to decide which collection to search.

**No semantic search for injection.** Keyword search (BM25) runs in ~30ms.
Semantic search (vector) takes ~2s. For injection that runs every turn, latency
matters. Keyword search is the default; the agent can use semantic mode
explicitly via `memory_search` when keyword isn't enough.

**No entry boundary tracking.** qmd handles markdown-aware chunking internally.
We don't need to maintain our own chunk boundaries or entry delimiters.

## Verification

### Level 1: Deterministic Unit Tests (bun:test)

No LLM, no qmd, no network. Tests use temp directories and test-only path
overrides (`_setBaseDir`) to verify core logic:

```
  bun test test/unit.test.ts

  17 describe blocks, 76 tests total. Key coverage areas:

  Path helpers (todayStr, yesterdayStr, dailyPath, etc.)
    format, boundary, and idempotency checks                          16 tests

  readFileSafe
    existing, missing, empty, and unicode files                        4 tests

  parseScratchpad / serializeScratchpad
    checked/unchecked items, metadata capture, round-trip             15 tests

  buildMemoryContext
    empty state, individual sections, combined output,
    whitespace-only file handling                                      8 tests

  qmd helpers (scheduleQmdUpdate, qmdInstallInstructions)
    no-op when unavailable, debounce behavior, instruction content     7 tests

  memoryWrite
    append/overwrite to MEMORY.md and daily, timestamps, session IDs   8 tests

  scratchpadAction
    add/done/undo/clear_done/list, case-insensitive matching,
    error cases, first-match-only behavior                            15 tests

  memoryRead
    long_term/scratchpad/daily/list targets, missing files,
    date filtering, non-md file exclusion                             12 tests

  memorySearch
    graceful error with setup instructions when qmd unavailable        1 test
```

### Level 2: CLI + Integration Tests (bun:test)

Tests import core functions directly and also invoke the `agent-memory` binary
as a subprocess via `Bun.spawnSync`. No LLM required:

```
  bun test test/cli.test.ts

  7 describe blocks, 31 tests total:

  core imports
    path helpers return expected values, ensureDirs creates structure   4 tests

  write operations
    long_term create/append/overwrite, daily log create/append         5 tests

  read operations
    long_term/scratchpad/daily reads, list daily logs                  5 tests

  scratchpad operations
    add/done/clear_done/list cycle                                     4 tests

  context building
    empty state, MEMORY.md, daily, scratchpad, search results          5 tests

  CLI subprocess
    init, status, write/read round-trip, context, scratchpad,
    help output, unknown command error                                 7 tests

  install scripts
    install-skills.sh copies all 4 skill files into HOME               1 test
```

### Level 3: Recall Effectiveness Eval (Planned)

A structured A/B evaluation comparing recall with and without selective injection.
Not yet implemented; the outline below captures the intended methodology.

The corpus spans 30 days of simulated project history:

```
  Source          Entries  In default injection?  Needs search?
  -----------     -------  --------------------   -------------
  long_term       15       Yes (up to 4K)         Maybe*
  today            1       Yes (up to 3K)         No
  yesterday        1       Yes (up to 3K)         No
  3-30 days ago    8       No                     Yes
```

*MEMORY.md entries beyond the 4K truncation point are not injected without search.

Questions are scored by keyword matching against expected answers. The eval
outputs per-question hits and a breakdown by source type:

```
  ID                 Source          With Search     Without         Delta
  ----------         ----------      -----------     -------         -----
  db                 long_term       1/1             1/1             0%
  auth               long_term       1/1             1/1             0%
  ...
  older_fts          older_daily     1/1             0/1             +100%
  older_orm          older_daily     1/1             0/1             +100%
  older_ci           older_daily     1/1             0/1             +100%
  ...
  TOTAL                              15/15           10/15           +33%
```

**Hypothesis:** Selective injection should show the largest delta on
`older_daily` questions — entries from 3+ days ago that aren't in the default
injection window. For `long_term` entries within the 4K budget, both conditions
should perform similarly. For `today` and `yesterday`, both should hit since
those are always injected.

**Status:** Not implemented. The numbers above are illustrative, not measured.

## Open Questions

**Is 3 seconds enough for search?** The timeout keeps injection latency
acceptable. On a cold qmd instance (first query after idle), startup may
exceed this. No latency data yet.

**Does keyword search suffice for injection?** We chose BM25 over semantic search
for speed (~30ms vs ~2s). If the user's prompt uses very different wording than
the stored memory ("what DB do we use?" vs "Chose PostgreSQL"), keyword search
may miss. The agent can fall back to `memory_search` with semantic mode, but
injection won't catch it. The eval is designed to measure this gap.

**How large can MEMORY.md grow before the 4K budget hurts?** With 15 entries in
the test corpus, most fit in 4K. A real project accumulating entries over months
will exceed this. The middle-truncation strategy keeps the first and last entries
visible but drops the middle. We don't know if this is the right tradeoff vs
tail-only truncation.

**Should session handoff be automated?** When the context window fills and old
messages are dropped, the agent loses awareness of what it was doing. A
`session_before_compact` hook could capture open scratchpad items and recent
daily log entries, appending them as a handoff block in today's daily log. The
next turn would pick this up via priority-2 injection. This is not yet
implemented — the question is whether the added complexity is worth the
continuity benefit.

## Conclusion

agent-memory is a bet on simplicity. Markdown files instead of databases.
Full-text search instead of vector indexes. Content conventions instead of
metadata schemas. Automatic injection instead of manual retrieval.

The Letta benchmark suggests this class of approach can match or exceed more
complex architectures — at least for retrieval tasks. The testing verifies the
mechanics work. The open question is whether selective injection meaningfully
improves recall in practice.

Total implementation: ~1,100 lines of TypeScript in `src/core.ts`, ~600 in
`src/cli.ts`. Zero runtime dependencies. Optional qmd for search.
