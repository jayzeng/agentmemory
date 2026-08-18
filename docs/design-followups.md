# Design follow-ups

The production-readiness review at `artifacts/agentmemory-production-readiness-review.html`
catalogs four High findings that require product-level decisions rather than tight code
fixes. Those items were deliberately excluded from the batch of hardening changes made
in the current commit — they are captured here as design proposals to be scoped and
delivered in a subsequent milestone.

## SEC-06 — Project/workspace isolation

**Problem.** All memory currently lives under a single `~/.agent-memory/` directory.
Facts, source paths, client names, and operational details from one repository leak
into every other project the same user works on.

**Proposal.**

1. Add three explicit scopes: `global` (default), `user`, `project`.
2. Layout under `~/.agent-memory/`:
   - `global/MEMORY.md`, `global/daily/`, `global/topics/`
   - `projects/<project-id>/MEMORY.md`, `projects/<project-id>/daily/`, ...
3. Resolve `<project-id>` from `AGENT_MEMORY_PROJECT` env, then from a `.agent-memory-project`
   file walking up from CWD, then from a hash of the git remote origin URL, then default
   to `global`.
4. Extend the write and read APIs with a `scope?: "global" | "project"` parameter.
5. Context injection blends both scopes, with per-scope caps (project scope wins ties).
6. Provide a `migrate` command that moves existing content to the appropriate scope
   based on file provenance hints (e.g., mentions of a repo path).

Tests: scope-resolution matrix (env > file > remote > default), context blending caps,
migration idempotency.

## SEC-09 — Structured trust metadata

**Problem.** `Trust: untrusted` / `Status: expired` / `Valid until:` are recognized only
by regex-scanning the entry body. Imported transcripts and third-party memory become
agent instructions by default; the current mechanism is brittle even after SEC-01.

**Proposal.**

1. Introduce a YAML frontmatter envelope prepended to every stored entry:
   ```
   ---
   trust: verified | untrusted
   source:
     kind: manual | claude-transcript | codex-transcript | import
     uri: qmd://...
     agent: claude-code | codex | cursor | cli
   lifecycle:
     status: active | expired | superseded | revoked | retired
     validUntil: 2025-12-31
   ---
   ```
2. Default `trust` = `untrusted` for any write whose `sourceUri` originates outside
   `MEMORY_DIR`.
3. Context injection renders untrusted entries as fenced data blocks, not as
   instruction-style prose.
4. Add `agent-memory trust <entryId> --verify` / `--revoke` commands.

Tests: end-to-end trust propagation from write → filter → context render; import path
default to untrusted; verify/revoke round trips.

## API-05 — Instance-based MemoryStore

**Problem.** `src/core.ts` holds 14 module-level mutable symbols (paths, qmd flags,
timers, adapter overrides). Consumers can't run multiple stores in one process, and
concurrent tests interfere via the shared globals.

**Proposal.**

1. Extract a `MemoryStore` class holding `{ dir, qmd, execFile, spawn, home }`.
2. Every public function becomes an instance method; module-level exports become thin
   wrappers around a lazily-created default instance so existing consumers keep working.
3. `_setBaseDir` / `_setQmdAvailable` / etc. become fields on the default instance;
   test hooks accept an explicit instance.
4. `createMemoryStore({ dir, qmd })` factory in the public API.

Tests: two parallel stores writing to different dirs stay isolated; existing
top-level functions still pass current test suite.

## DATA-04 — Versioned entry envelope + verify/backup/restore

**Problem.** Memory files carry no schema/version marker, migration path, integrity
check, or repair command. Future parser changes and accidental corruption have no
controlled recovery.

**Proposal.**

1. Prepend every stored entry with a `<!-- entry-schema: v1 -->` sentinel; write a
   `MEMORY_DIR/.schema.json` recording the store-level version.
2. Add `agent-memory verify` — walks all files, parses each entry, reports schema
   version, unreadable entries, dangling references, oversized files.
3. Add `agent-memory backup` — writes a timestamped tarball to
   `MEMORY_DIR/.backups/YYYYMMDD-HHMMSS.tar.gz`; rotate to keep last 10.
4. Add `agent-memory restore <backup>` — atomic swap of current dir with a backup
   (via `.restore-in-progress` sentinel and rollback on failure).
5. Migration contract: `migrations/vN-to-vNplus1.ts` files in the source tree, run
   automatically by `verify --migrate` or on first CLI invocation post-upgrade.

Tests: forward migration of a v0 fixture; backup/restore round trip with concurrent
writes; verify reports on synthetic corruption fixtures.
