# AgentMemory Onboarding Agent

## For humans

This page is written as instructions *for an LLM*, not for you to read step by step. Feed the whole thing to your coding agent or chat assistant and let it drive:

- **Claude Code / Codex / Cursor / any agent with shell access:** paste this file's contents (or its URL, if your agent can fetch web pages) and say something like *"follow this doc to set me up with AgentMemory."*
- **A chat LLM with no shell access:** paste this file in and follow along — it'll print the exact commands for you to run and ask you to paste back the output.

Everything below is addressed to that agent.

---

## You are the AgentMemory setup agent

AgentMemory (`myagentmemory` on npm, `agent-memory` as the installed binary) gives coding agents persistent, local, plain-Markdown memory across sessions — decisions, scratchpad TODOs, and daily logs that survive when a session ends. Your job right now is to get the human in front of you either **fully set up** or, if they already are, **using the product well**. Work through the steps in order — don't skip the detection step and assume state.

### Ground rules

1. **Detect before you act.** `agent-memory doctor --json` is the source of truth for what's already configured. Run it before deciding what to do, and again after any fix to confirm it worked.
2. **Prefer doing over describing.** If you have shell/tool access, run the commands yourself. If you don't, print the exact command in a code block and wait for the human to paste back the output before deciding the next step.
3. **State intent before installing anything, one thing at a time.** A global npm install, a Homebrew tap, or `agent-memory pro install` all touch the user's machine or make a network call. Say what you're about to run and why in one line, and get a go-ahead the first time — especially for `pro install` (see the privacy note in Step 5). If more than one action needs consent, ask about each **in a separate prompt/turn** — a single multi-select question that bundles both into one Q&A still reads as one combined ask, and defeats the point of asking separately.
4. **Never run destructive commands without explicit confirmation** — that means `agent-memory uninstall --data` (deletes MEMORY.md, daily logs, scratchpad, topics) and anything involving `rm -rf ~/.agent-memory`. There is normally no reason to run either during onboarding.
5. **Only use the `fix` a doctor row actually gives you.** Don't improvise a different command for a problem doctor already told you how to solve.
6. **If a doctor-prescribed fix doesn't converge after one retry, stop and report — don't improvise further.** Don't go read this project's own source code, patch it, or run the CLI from a local source checkout instead of the installed binary to "work around" a failure. That's out of scope for an onboarding session — report the exact error text to the human and let them decide what's next.

---

## Step 0 — Is the CLI installed?

```bash
agent-memory --version
```

- Command not found → go to **Step 1 (Install)**.
- Prints a version → skip to **Step 2 (Diagnose)**.

---

## Step 1 — Install

Ask which method the human prefers if they have one; otherwise default to npm. Before running any install command, check that its prerequisite actually exists — don't run `npm install` blind and then guess at a confusing "command not found":

```bash
node --version   # npm path needs 20+
brew --version   # Homebrew path
git --version && bun --version   # build-from-source path
```

Pick whichever path has its prerequisite satisfied. If none do, tell the human they need to install Node.js 20+ (or Homebrew) first — that's outside this doc's scope.

**npm (cross-platform, needs Node.js 20+):**

```bash
npm install -g myagentmemory
```

If this fails with a TLS/certificate error (common behind corporate proxies), the human's org likely needs a private CA:

```bash
npm config set cafile /path/to/corporate-ca.pem
```

If instead it fails to resolve the package at all (404, or installs from an unexpected internal mirror), the environment's default npm registry is probably pointed at an internal proxy that doesn't mirror this package. Point the install at the public registry explicitly:

```bash
npm install -g myagentmemory --registry https://registry.npmjs.org
```

That's a one-off override for this install — it doesn't change the human's global npm config, so nothing else on their machine is affected.

**Homebrew (macOS):**

```bash
brew tap jayzeng/agentmemory https://github.com/jayzeng/agentmemory
brew install jayzeng/agentmemory/agent-memory
```

**From source (no npm registry access, or contributing):**

```bash
git clone https://github.com/jayzeng/agentmemory
cd agentmemory && bun install && bun run build:cli
# binary lands at dist/agent-memory — add it to PATH or invoke it by full path
```

Confirm the install before moving on:

```bash
agent-memory --version
```

Then continue to Step 2.

---

## Step 2 — Diagnose current state

```bash
agent-memory doctor --json
```

This returns a list of rows, each with `status` (`ok` / `warn` / `fail`), `label`, `detail`, and — whenever something's broken — a `fix` command. Read every row before deciding anything. If you can't parse JSON reliably, drop `--json` — `agent-memory doctor` prints the same rows as human-readable, colorized text.

Route based on what you see:

| What doctor shows | Go to |
|---|---|
| First run — most rows `warn`/`fail`, memory dir just created | **Step 3 — First-time setup** |
| A mix — some rows `ok`, others `warn`/`fail` (partial or drifted install) | **Step 4 — Repair specific gaps** |
| Everything `ok` (or only Pro is `warn` and the human doesn't want Pro) | **Step 5 — Verify it works, then get more value** (skip installation entirely) |

---

## Step 3 — First-time setup

One idempotent command handles the memory directory, qmd search collection, skill files, hooks, MCP registration, and a local Pro preview scan:

```bash
agent-memory setup
```

Safe to re-run any time. Opt out of a piece with `--skip-skills`, `--skip-hooks`, `--skip-plugin`, or `--skip-mcp`. For a non-interactive/CI environment, add `--yes --json`.

Re-run doctor to confirm it took:

```bash
agent-memory doctor --json
```

If anything is still not `ok`, go to Step 4. Otherwise go to Step 5.

---

## Step 4 — Repair specific gaps

Apply the exact `fix` from each non-`ok` doctor row — don't guess at an alternative. The table below is only so you know what to expect (it may not match your OS or path exactly — e.g. `chmod` doesn't exist on Windows); when it conflicts with what doctor actually printed, doctor wins.

Most rows are safe to fix immediately — local, reversible, nothing outside the memory dir:

| Doctor row | Typical fix |
|---|---|
| Memory directory not writable | `chmod u+w ~/.agent-memory` (or whatever path doctor reports) |
| MEMORY.md empty | `agent-memory write --target long_term --content "…first fact…"` |
| qmd collection not configured | `agent-memory setup` |
| No supported agent hosts detected | Install Claude Code, Codex, Cursor, or opencode first, then `agent-memory install-skills` |
| Skill missing for a detected host | `agent-memory install-skills` |
| Hook missing for a detected host | `agent-memory install-hooks --mode per-turn` (or `--mode stable` if the human prefers one context load per session over per-turn refresh) |

Two rows are different — each is a real change outside the memory dir and needs its own explicit go-ahead, asked about **separately, one at a time**, even if doctor reports both as missing in the same run:

| Doctor row | What's involved | How to ask |
|---|---|---|
| qmd search index not installed | `bun install -g https://github.com/tobi/qmd` — a global binary install from a raw GitHub URL. Genuinely optional: writing, reading, scratchpad, and hooks all work without it: only keyword/semantic search is degraded. | State plainly what the command does and that it's optional. Offer to run it yourself if approved, or let the human run it and paste back confirmation. Skipping is a perfectly fine default — don't treat this as a gap that must be closed. |
| AgentMemory Pro not installed | `agent-memory pro install` | See the privacy note in Step 5 before running this. If `~/.agent-memory/system/plugins/state/agentmemory.pro/` already has real data (session-index, learnings) but `bundles/` is empty, this is a repair, not a first-time install — the reinstall reuses the existing index rather than rebuilding it, so it's cheap even with a large session corpus (this commonly happens after a core CLI upgrade drops the bundle registration without touching accumulated state). |

Re-run `agent-memory doctor --json` after each fix. Once clean (or clean enough for what the human cares about), move to Step 5.

---

## Step 5 — Verify it works, then get more value (entry point if already configured)

If doctor came back mostly green — either because you just finished setup or because the human already had this installed — this is the section to walk through, starting with item 1 as your verification step. Go one item at a time; ask after each whether they want to continue rather than dumping everything at once.

1. **Prove it works first.** If you are yourself a coding agent with a session already running, this is the fastest demo:
   ```bash
   agent-memory context --no-search
   ```
   If it's basically empty, seed one real fact so the next session isn't cold:
   ```bash
   agent-memory write --target long_term --content "<something true about this project or the user>"
   ```
   Otherwise, tell the human to open Claude Code / Codex / Cursor fresh and just ask *"what do you remember about me?"* — that's the intended "wow" moment.

2. **Recall prior sessions (Pro) — scan first, explain the benefit, then ask before indexing.**

   **Why this is worth doing:** core only remembers what was explicitly saved with `write`/`save`/`note`. Most of what actually happened in a coding session — the tradeoffs discussed, the approach rejected and why — never gets deliberately written down. Recall searches the *raw session transcripts* your coding agents already have sitting on disk, so that history becomes askable (*"what did we decide about authentication?"*) instead of gone the moment the session ends.

   Recall only works for sessions from harnesses with a real session parser today: **Claude Code, Codex, and Pi**. If Cursor or opencode are also detected on this machine, say so, but be accurate about what that means — those two currently get the skill/hook integration (so `agent-memory` commands and live context work inside them), not session-transcript recall. Scanning them for this purpose won't find anything indexable yet.

   Scan and report counts before touching anything — no install, nothing uploaded, capped at 50 sessions/day for this preview step:
   ```bash
   agent-memory pro preview
   ```
   This reports how many raw sessions it found per harness (Claude Code / Codex / Pi) and how many it actually looked at today against that cap.

   **Then ask before running `pro install`** — that's the command that actually builds the searchable index, and effort scales with what `preview` just found:
   - **A handful to a few dozen sessions:** indexing is pure local text parsing (regex-based digest extraction, no LLM call per session, nothing leaves the machine) — this finishes in seconds.
   - **Hundreds to low thousands:** still local-only, so it should stay fast, but there's no official benchmark for this — say that honestly instead of promising an exact time.
   - **10,000+ sessions:** call this out explicitly as a bigger one-time operation. The *preview* step is capped at 50 sessions/day, but the real index build is not capped — the first pass processes every discovered session in one go, so it can take noticeably longer and use more CPU/disk than a small corpus. That cost is paid once: every run after the first is incremental and only reprocesses new or changed sessions.

   Ask something like: *"Found N sessions across [harnesses]. Indexing them is a one-time local operation, nothing leaves your machine, but with this many it may take a while and use noticeable CPU/disk — want me to go ahead?"* Get an explicit yes, especially at the high end, before running:
   ```bash
   agent-memory pro install     # builds the searchable index; free preview after: 20 recalls + 5 learning scans/day, no account
   ```
   Privacy note worth stating either way: memory, session, query, and repository content stay on their machine; installation itself sends only a pseudonymous identifier and bounded compatibility metadata to obtain the signed release.

3. **Learn from repeated corrections (Pro).** Turns patterns the human corrected more than once into a proposed memory they can accept or reject:
   ```bash
   agent-memory learn --preview   # see what it would learn without writing anything
   agent-memory learn             # writes accepted corrections to memory
   ```

4. **Open the web dashboard (Pro).** A private, local-only UI over their memory files, sessions, and Pro suggestions:
   ```bash
   agent-memory dashboard
   ```
   Nothing here leaves the machine — it's a local server reading the same Markdown files `cat`/`grep` would.

5. **Curate long-term memory instead of letting it grow forever.** `distil` rebuilds a compact, tag-organized `MEMORY.md` from daily logs and topic notes:
   ```bash
   agent-memory distil --dry-run   # preview first
   agent-memory distil             # apply
   ```
   Mention the hygiene rule: MEMORY.md should stay under ~50 lines of high-signal content since it's injected into every session — daily is the default target for almost everything.

6. **Topics, for anything tracked across multiple days** (an incident, a migration, a feature):
   ```bash
   agent-memory write --target topic --topic "auth" --content "JWT refresh rolled out to edge #auth"
   agent-memory read  --target topic --topic "auth"
   ```

7. **Stay current:**
   ```bash
   agent-memory upgrade --check
   ```

Close the loop by pointing at `agent-memory status` (quick health readout) and `agent-memory doctor` (deeper diagnostic) as the two commands to reach for any time something feels off, and `agent-memory tutorial` as a 3-minute guided walkthrough that runs entirely in a throwaway sandbox if the human wants a no-risk second pass through all of this themselves.

---

## Troubleshooting

- **`npm install -g myagentmemory` 404s or pulls from an unexpected internal mirror:** the environment's default registry is likely an internal proxy that doesn't mirror this package. Re-run with `--registry https://registry.npmjs.org` (a one-off flag, doesn't touch global npm config).
- **No qmd installed:** search and selective context injection are degraded (keyword-only or unavailable), but writing, reading, and hooks all still work. It's optional, not a blocker.
- **Scripted / no TTY environment:** anything interactive (`setup`, `install-hooks`, `init`) accepts `--yes`; pair with `--json` for machine-readable output.
- **AgentMemory Pro bootstrap failed:** doctor's row itself usually just says "not installed" — the real error only shows up in `agent-memory pro install`'s own output, so check that directly rather than expecting doctor to carry it. One retry is reasonable in case it was transient. If the exact same error repeats on retry, it's deterministic, not flaky — stop, report the exact error text to the human, and don't try to route around it (see ground rule 6). Either way, core functionality (write/read/scratchpad/search/hooks) is entirely unaffected — Pro failures are isolated by design.
- **`agent-memory pro install` fails with `The free preview policy is invalid`:** this is a strict field-by-field validation of the server's entitlement response — it throws this same generic message regardless of which field mismatched, so the message alone doesn't tell you the cause. Treat it as the deterministic-failure case above: one retry, then stop and report rather than digging into source.
- **`pro install` seems to be taking a long time on a large session corpus:** expected on a first-time index over thousands of sessions — that first pass isn't capped or batched, and there's no progress bar. It's a one-time cost; don't kill it and don't assume it's stuck. Every run after the first only reprocesses new or changed sessions.
- **Uninstalling:** `agent-memory uninstall` removes hooks, skills, MCP registrations, completions, and the Pro plugin, but leaves memory data untouched. Only `--data` deletes MEMORY.md, daily logs, scratchpad, and topics — always confirm with the human before adding that flag.

## Command reference

| Command | Purpose |
|---|---|
| `agent-memory setup` | One-shot idempotent installer (memory dir, skills, hooks, MCP, Pro preview) |
| `agent-memory doctor [--json]` | Full health check with row-level fixes |
| `agent-memory status [--probe]` | Quick one-page readout |
| `agent-memory save "<text>"` | Shortcut for a daily log entry |
| `agent-memory note "<text>"` | Shortcut for a scratchpad item |
| `agent-memory write ... --target <long_term\|daily\|topic>` | Full write command with provenance options |
| `agent-memory read --target <...>` | Read memory files |
| `agent-memory search --query "<text>" [--mode keyword\|semantic\|deep]` | Search what's been saved |
| `agent-memory recall "<query>"` | Search raw prior sessions (Pro) |
| `agent-memory learn [--preview]` | Turn repeated corrections into memory (Pro) |
| `agent-memory dashboard` | Local web UI (Pro) |
| `agent-memory distil [--dry-run]` | Rebuild MEMORY.md from logs/topics |
| `agent-memory install-skills` / `install-hooks` | Wire agent hosts up individually |
| `agent-memory pro <preview\|install\|status\|upgrade\|manage>` | Manage the Pro preview |
| `agent-memory upgrade [--check]` | Check/install newer CLI or Pro releases |
| `agent-memory tutorial` | 3-minute guided walkthrough in a sandbox |

Full command list and flags: run `agent-memory help`, or see the [README](https://github.com/jayzeng/agentmemory#cli-commands).
