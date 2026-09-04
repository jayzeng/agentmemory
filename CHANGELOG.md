# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.4] - 2026-09-03

### Changed

- Removed unavailable paid-plan and automatic-capture calls to action from free-preview CLI output, corrected supported transcript hosts, and qualified remaining privacy copy for coding-agent/model-provider handling.
- Documented the Node.js 22.13+ requirement for npm-hosted Pro session indexing while preserving Core's Node.js 20+ support.
- Stop hook's memory-write nag now uses `hookSpecificOutput.additionalContext` instead of `decision: "block"` — same effect (still holds the turn open via `stop_hook_active`), but renders as "Stop hook feedback" instead of "Stop hook error" in the transcript.

### Fixed

- Updated the Homebrew formula to the tagged Core 0.5.3 source archive and checksum.
- `serve --mcp` now exits promptly after stdin closes even when a Pro plugin keeps a resource open, such as the session-intelligence plugin's `fs.watch` handles on the pi/codex/claude session roots. `StdioMcpServer` gained a shutdown-hook mechanism (`registerMcpShutdown`) plus a hard `process.exit(0)` backstop.

## [0.5.3] - 2026-09-02

### Added

- `agent-memory uninstall [--data] [--yes]` — removes hooks, skills, MCP registrations, shell completions, and the Pro plugin in one step. By default your memory data (`MEMORY.md`, daily logs, scratchpad, topics, qmd index) is left untouched; pass `--data` to also delete it and the plugin install root, after explicit confirmation.
- Qoder CLI support — skill installation (`~/.qoder/skills/agent-memory/`) and a `SessionStart` hook (`~/.qoder/settings.json`) for automatic memory context injection, using the same idempotent marker-based install/uninstall as Claude Code.
- `pi` (Pi Coding Agent) is now a first-class hook target alongside Claude Code, Codex, Cursor, and opencode. Since pi has no JSON/TOML hook config to edit, `agent-memory setup`/`install-hooks` delegates to the [`pi-memory`](https://github.com/jayzeng/pi-memory) extension via `pi install npm:pi-memory` rather than shipping a competing extension; `doctor` reports the install outcome/history from a local `pi-memory-state.json`.
- `agent-memory upgrade policy [off|notify|auto]` — per-target (CLI/Pro) control over whether upgrades install automatically, just notify, or are left alone. `doctor` gets an "Auto-upgrade" row reporting the current policy.
- `agent-memory upgrade --background` — a detached, non-interactive install path spawned from `hook session-start` that only installs a target whose persisted policy is `"auto"`; failures are recorded and surfaced passively on the next session start, never thrown.

### Changed

- Kept plugin API 1 source-compatible after MCP capability gating: legacy MCP tool descriptors may omit `requiredCapability`, but Core refuses to execute them until the bundle is updated.
- Replaced the deprecated server-side SessionStart metering client with a versioned pseudonymous activation record that stores no unused usage credential.
- Qualified local-first privacy copy so it distinguishes data AgentMemory's services never receive from recall context subsequently handled by the user's coding-agent/model provider.

### Fixed

- Detect the official Homebrew Cellar install and upgrade it through `brew` instead of falling back to a second global npm install.
- Relaunch compiled Bun/Homebrew executables without passing their virtual `/$bunfs/` script path, while preserving the newer background auto-upgrade policy.

## [0.5.2] - 2026-09-01

### Fixed

- Enforced entitlement checks on MCP tools registered by plugins — previously they ran with no capability gating at all, unlike commands, hooks, and context providers. `PluginMcpToolV1` now requires a `requiredCapability`, registration rejects an undeclared one, and a new `runMcpTool()` re-checks entitlement on every call so a lapsed trial actually disables a tool mid-session instead of only at registration.
- Lowered the Stop-hook memory-write nudge interval from 12 to 6 turns — most real sessions never reached 12, so the nudge almost never fired in practice.
- Pointed `memory_read`'s empty-state message at `agent-memory recall` / `session_recall` / `session_search` instead of a bare `(empty)`, so cross-session history stays discoverable even when curated memory has nothing saved yet.

## [0.5.1] - 2026-09-01

### Fixed

- Resolved symlinked global npm installs (e.g. `npm install -g`) before scanning for the bundled `skills/` directory, fixing `agent-memory setup` failing with "Could not locate the skills directory" on such installs.
- Routed onboarding hints (qmd-collection-not-found errors, `status`/`doctor` fixes, the tutorial cheat sheet, and bundled `SKILL.md` setup instructions) from the unlisted `init` command to `agent-memory setup`.
- Re-pinned the Homebrew formula's release archive checksum.

## [0.5.0] - 2026-08-30

### Added

- Added agent-neutral setup, diagnostics, MCP, retrieval evaluation, and optional signed-plugin host surfaces while keeping the public package independent of proprietary plugin implementations.
- Added a deterministic regression harness, token-savings simulator, and expanded synthetic evaluation corpus for release verification.
- Added native Cursor session-start context wiring and a bounded Claude Code Stop-hook reminder for durable memory writes.

### Changed

- Switched qmd recall to one typed lexical-and-vector query with bounded, source-filtered context injection.
- Prepared a distinct public package version for the accumulated post-0.4.17 changes.
- Standardized the free installed preview at 20 recalls and 5 learning scans per local day.

### Fixed

- Enforced the documented free-preview contract in trusted Core code: 20 recalls and 5 learning scans per device-local day, with automatic background capture disabled.
- Isolated the anonymous Pro-install CLI test from the live production service so a healthy preview deployment cannot make the deterministic Core suite fail.
- Abort qmd and optional-plugin work when the per-turn hook reaches its three-second budget so a child process cannot keep the CLI alive.
- Replaced organization-specific example and evaluation data with explicitly fictional fixtures.
- Clarified Jay Zeng's copyright in original contributions and preserved the upstream `jo-inc` MIT notice and existing MIT grants.
- Warn when duplicate memory lines or configured per-line limits would reduce context quality.
- Made clean-checkout CI and release workflows run the token-savings and compiled-CLI harness suites.
- Routed MCP reads and scratchpad writes through Core secret screening and report the actual package version during MCP initialization.

## [0.4.17] - 2026-08-17

### Added

- Added the product-facing `agent-memory pro install|status|upgrade|manage` namespace and `agent-memory dashboard` alias while retaining low-level `plugin` and `web` compatibility commands.
- Added a first-class Core/Pro section to the public site with outcome-based messaging and the no-account preview contract.

### Changed

- Replaced required pre-use email collection with a random anonymous installation identifier and a non-interactive free-preview access request.
- Reframed Pro around coding-history recall, learning from repeated corrections, and the local Memory Dashboard.
- Reconstructed the free policy as 10 device-local recalls and one device-local learning scan per day, with indexing and Dashboard access available and automatic background capture disabled.
- Added a bounded, capability-gated plugin context-provider bridge so approved learned memory can appear in generated Core context.

### Fixed

- Kept identity, billing, and browser activation out of the first-use path while preserving signed release verification and transactional installation.
- Aligned the top-level command table and generated it from the CLI registry so Pro commands such as `dashboard` and the `help` command are always visible.
- Preserved the upstream `pi-mem` MIT copyright notice in the distributed license.
- Hardened release automation with immutable action pins.

## [0.4.16] - 2026-08-17

### Changed

- Redesigned the loopback activation and completion pages with a focused responsive card layout, clearer activation copy, extension-safe email input spacing, accessible focus/error states, and progressive privacy disclosure.

## [0.4.15] - 2026-08-17

### Added
- Account-scoped daily capability quotas and fail-closed SessionStart usage reservation, commit, and release contracts
- Activation-v2 support for server-issued usage credentials and server-backed free-session metering
- Installed-plugin SessionStart hook dispatch while preserving public-core context when paid work is unavailable or exhausted

### Changed
- Replace temporary unlimited email activation with a configurable free daily agent-session allowance keyed by normalized email
- Persist an activation credential only after the control plane accepts activation; reconstruct the free account-metered capability policy in trusted core code on every load
- Disclose the bounded server-tracked usage count and opaque SessionStart operation IDs on the activation page

### Fixed
- Ignore legacy or malformed local activation records instead of treating them as active entitlements
- Release a reserved free session when plugin SessionStart work fails and keep duplicate server operations idempotent

## [0.4.14] - 2026-08-17

### Added
- Versioned public plugin-host types and manifest validation through the `myagentmemory/plugin-host` export
- Plan-neutral capability grants, device-local quota policy, and per-command/hook capability requirements in plugin-host API v1
- Fail-closed official-plugin bootstrap commands, signed Ed25519 release verification, bounded package validation, atomic install/upgrade/rollback, explicit uninstall, and deterministic regression coverage
- Temporary loopback email activation with a permission-restricted local record, unlimited capability grants, live commercial catalog/artifact retrieval, installed-bundle health checks, and paid-command dispatch
- Official plugin runtime loading with manifest validation, shared bundle state, per-command capability enforcement, memory host APIs, abort handling, and Web Console support
- Core-owned managed SessionStart hook installation for Claude Code, Codex, Cursor, and OpenCode
- Bash, Zsh, Fish, and PowerShell completion generation and idempotent installation through public exports

### Changed
- `agent-memory init`, `status`, and help now expose non-blocking optional-plugin discovery without affecting core memory behavior or opening a browser
- Separate commercial plan identifiers from locally derived active/grace/missing/expired entitlement states
- Clarify that AgentMemory core remains free and MIT-licensed while optional plugin implementations are distributed separately under their own terms
- Run unit, CLI/package-portability, and evaluation suites before npm publication
- Made Pro discovery, install, upgrade, and current-version output explain the included Session Intelligence, guided learning, local Web Console, privacy boundary, and useful next commands
- Sent an explicit, bounded Pro activation record to the private control plane with transparent browser disclosure; the payload excludes memory, sessions, queries, paths, IP addresses, and user-agent strings

### Fixed
- Pin the npm release client to the tested 11.6.2 toolchain so package-portability verification remains stable before publication
- Normalize the CLI executable path so npm preserves the `agent-memory` binary during publication
- Expose the real core memory directory to permission-checked first-party plugins so local interfaces do not confuse plugin operational state with user memory
- Accepted same-origin loopback activation forms from browsers that omit `Origin` or serialize it as `null`, while preserving nonce/Host validation and rejecting cross-origin requests
- Reload local entitlement state before every installed-plugin command and bound error responses from the plugin service
- Replace unsafe TLS-disable installation guidance with corporate CA-file configuration
- Made the Homebrew update workflow match formula fields regardless of indentation and fail when expected fields are missing
- Build public `dist` exports during commit-pinned Git dependency installation
- Allow host adapters to write through the core memory contract to an explicit directory without mutating process-global core state

## [0.4.13] - 2026-08-10

### Added
- External-feedback evaluation dataset with deterministic capability probes, isolated multilingual qmd retrieval, and explicit qualitative boundaries
- `eval:feedback` and `test:eval` commands for running and validating the feedback evaluation
- Source provenance on the shared write contract and CLI via `--source-uri`
- Secret screening and trust/temporal filtering for persisted and injected memory
- GitHub release notes template at `.github/release.yml`
- Repository social preview asset at `.github/assets/social-preview.png`
- GitHub Pages landing page at `docs/index.html` to promote installation and usage
- GitHub Actions Pages deploy workflow at `.github/workflows/deploy-pages.yml`

### Changed
- Added optional prompt-aware retrieval through `context --query` for direct argument-array callers; bundled skills retain session-start context and explicit search
- Consolidated CLI memory writes on the core write path and preserved early daily evidence with head-plus-tail context selection
- Improved discoverability metadata and SEO copy across repository docs and package metadata (`agentmemory`, `agent-memory`, `myagentmemory` aliases)
- Fixed `package.json` repository, bugs, and homepage URLs to canonical repo `https://github.com/jayzeng/agentmemory`
- Updated Homebrew formula description to include `agentmemory` naming

### Fixed
- Made global npm installs portable across macOS, Linux, and Windows by shipping the Node.js CLI instead of a macOS Apple Silicon binary
- Enforced the complete 16,000-character context cap, including truncation diagnostics
- Excluded complete inactive, expired, and untrusted write entries from direct, distilled, and qmd context; failed closed for unmarked metadata headers; handled BOM-prefixed entry files and qmd context envelopes; resolved qmd URI casing safely; and redacted recognized secrets before persistence or response output
- Cleared prompt-retrieval timers after successful searches and aborted timed-out qmd calls so the CLI does not wait unnecessarily
- Clarified that AgentMemory is not a Python SDK, vector database, or knowledge graph
- Exercise prompt routing through the CLI boundary, preserve provenance inputs in write probes, fail requested qmd setup errors, and type-check evaluation sources
- Restored Agent CLI skill parity in installers by adding `.agents` target to `installSkills()`, `uninstallSkills()`, and `scripts/install-skills.sh`

## [0.4.9] - 2026-02-21

### Added
- Topic/event notes stored under `topics/` with `write --target topic` and `read --target topic|topics`
- Distil now includes a Topics section with per-topic summaries and backlinks
- qmd auto-setup registers a `/topics` context
- Pi usage note pointing to `pi-memory` native extension as an alternative to the CLI + skill workflow
- Homebrew tap formula for installing the compiled CLI on macOS
- GitHub workflow to auto-update the Homebrew formula on tag releases

### Changed
- CLI status output includes topic counts
- Distil summary includes topic file counts
- Context injection now includes recent topic entries

## [0.4.8] - 2026-02-21

### Added
- `--uninstall` flag for `install-skills` CLI command and shell script
- `uninstallSkills()` function in core.ts for programmatic skill removal
- Unit tests for uninstall across all three layers (core, CLI subprocess, shell script)

### Fixed
- Shell script `install-skills.sh` crash when optional 5th argument not passed (Cursor/Agent CLI targets)
- Biome formatting issues (import ordering, operator precedence parentheses)

## [0.4.7] - 2026-02-21

### Fixed
- Tighten skill install detection logic

## [0.4.6] - 2026-02-21

### Added
- `install-skills` CLI command for programmatic skill installation

## [0.4.5] - 2026-02-20

### Added
- `version` CLI command
- qmd embed sync support

## [0.4.4] - 2026-02-20

### Added
- Cursor and Agent CLI skill support

### Fixed
- Node types and Biome dist ignore

## [0.4.3] - 2026-02-19

### Changed
- Renamed package to `myagentmemory` due to npm name conflict

## [0.4.2] - 2026-02-19

### Added
- Windows skill installer
- Buildable library output (`dist/`)

## [0.4.1] - 2026-02-19

### Added
- Initial public release
- Persistent memory system with MEMORY.md, SCRATCHPAD.md, and daily logs
- qmd-powered semantic search
- Skills for Claude Code and Codex
