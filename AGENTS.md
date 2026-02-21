# Repository Guidelines

## Project Structure & Module Organization

- `src/core.ts`: all logic — paths, truncation, scratchpad, context builder, qmd integration, standalone tool functions (`memoryWrite`, `memoryRead`, `scratchpadAction`, `memorySearch`)
- `src/cli.ts`: CLI entry point — subcommands (context/write/read/scratchpad/search/init/status), compiles to `dist/agent-memory` binary
- `skills/claude-code/SKILL.md`: Claude Code skill file
- `skills/codex/SKILL.md`: Codex skill file
- `skills/cursor/SKILL.md`: Cursor skill file
- `skills/agent/SKILL.md`: Agent (Cursor CLI) skill file
- `test/unit.test.ts`, `test/cli.test.ts`: unit tests (bun:test)
- `README.md`: user-facing install/usage docs

Runtime data lives outside the repo under the memory directory:
- Default: `~/.agent-memory/` (configurable via `AGENT_MEMORY_DIR`)

Files: `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`

## Activity Tracking (Required)

- Track all work sessions by writing a short entry to the daily log using `agent-memory write --target daily`.
- Summaries should include what changed, files touched, and any notable decisions.
- Use the scratchpad tool for follow-ups or TODOs discovered during work.

## Build, Test, and Development Commands

- `bun run build:cli`: compile CLI binary to `dist/agent-memory`
- `npm run build:lib`: emit `dist/` library build via `tsc`
- `npm run build`: typecheck with `tsc` (`--noEmit`)
- `npm run lint`: lint with Biome
- `bun test test/unit.test.ts` or `npm run test:unit`: run unit tests (no LLM/qmd needed)
- `bun test test/cli.test.ts` or `npm run test:cli`: run CLI unit tests
- `bash scripts/install-skills.sh` or `npm run install-skills`: install SKILL.md files for Claude Code and Codex
- Optional (for `memory_search`, requires Bun): `command -v qmd >/dev/null 2>&1 || bun install -g https://github.com/tobi/qmd`
- Optional search setup: `agent-memory init` (auto-creates qmd collection); run `qmd embed` once for semantic/deep search

## Coding Style & Naming Conventions

- `src/core.ts` has zero external dependencies: only `node:fs`, `node:path`, `node:child_process`.
- Match existing formatting: tabs for indentation, semicolons, and double quotes.
- Naming: `camelCase` for functions, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants; tool names remain `snake_case` (e.g. `memory_write`).

## Testing Guidelines

- Tests touch memory directories; ensure backups/restores remain intact and new tests don't leak user data.
- Unit tests use temp directories via `_setBaseDir()` — no real memory files.
- Prefer behavior-focused assertions (file contents, cross-session recall). Keep timeouts generous for model latency.

## Pre-Commit Checklist (Required)

Before every `git add`, `commit`, and `push`, you **must** run and verify all pass:

1. `bun test test/unit.test.ts` — unit tests
2. `bun test test/cli.test.ts` — CLI tests
3. `bun run lint` — Biome linting and formatting
4. `bun run build` — TypeScript type-checking

Do not commit or push if any of the above fail. Fix issues first.

## Changelog (Required)

- Maintain `CHANGELOG.md` at the project root.
- For every version bump, add an entry documenting Added, Changed, Fixed, and Removed sections as applicable.
- Review local + committed git changes (`git log`, `git diff`) to draft accurate changelog entries.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) and keep messages imperative.
- PRs: include a short summary, exact test command(s) run, and call out any changes to on-disk memory formats or `qmd` behavior.

## Security & Configuration Tips

- `AGENT_MEMORY_DIR` controls the memory directory (default: `~/.agent-memory`).
- `AGENT_MEMORY_QMD_UPDATE` controls qmd updates after writes (`background`, `manual`, `off`). `PI_MEMORY_QMD_UPDATE` is a legacy fallback.
- Never commit real memory files or secrets.

## Skills

A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### Available skills

- agent-memory: Persistent memory across coding sessions — long-term facts, daily logs, topic notes, scratchpad checklist, and semantic search. (file: /Users/jay/.agents/skills/agent-memory/SKILL.md)
- agent-memory: Persistent memory across coding sessions — long-term facts, daily logs, topic notes, scratchpad checklist, and semantic search. (file: /Users/jay/.codex/skills/agent-memory/SKILL.md)
- algorithmic-art: Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avoid copyright violations. (file: /Users/jay/.codex/skills/algorithmic-art/SKILL.md)
- find-skills: Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill. (file: /Users/jay/.agents/skills/find-skills/SKILL.md)
- polymarket-weather: Polymarket Weather Probabilities (KSEA/KLAX/KSFO) to predict weather (file: /Users/jay/.codex/skills/polymarket/SKILL.md)
- vercel-composition-patterns: React composition patterns that scale. Use when refactoring components with boolean prop proliferation, building flexible component libraries, or designing reusable APIs. Triggers on tasks involving compound components, render props, context providers, or component architecture. Includes React 19 API changes. (file: /Users/jay/.agents/skills/vercel-composition-patterns/SKILL.md)
- vercel-react-best-practices: React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements. (file: /Users/jay/.agents/skills/vercel-react-best-practices/SKILL.md)
- vercel-react-best-practices: React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements. (file: /Users/jay/.codex/skills/vercel-react-best-practices/SKILL.md)
- vercel-react-native-skills: React Native and Expo best practices for building performant mobile apps. Use when building React Native components, optimizing list performance, implementing animations, or working with native modules. Triggers on tasks involving React Native, Expo, mobile performance, or native platform APIs. (file: /Users/jay/.agents/skills/vercel-react-native-skills/SKILL.md)
- web-design-guidelines: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices". (file: /Users/jay/.agents/skills/web-design-guidelines/SKILL.md)
- web-design-guidelines: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices". (file: /Users/jay/.codex/skills/web-design-guidelines/SKILL.md)
- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: /Users/jay/.codex/skills/.system/skill-creator/SKILL.md)
- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: /Users/jay/.codex/skills/.system/skill-installer/SKILL.md)

### How to use skills

- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
- After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
- When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the skill directory listed above first, and only consider other paths if needed.
- If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.
- If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
- If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
- If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
- Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
- Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
- Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.
- When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
