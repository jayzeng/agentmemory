# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.4.15] - 2026-08-17

### Added
- Account-scoped daily capability quotas and fail-closed SessionStart usage reservation, commit, and release contracts
- Activation-v2 support for server-issued usage credentials and D1-backed free-session metering
- Installed-plugin SessionStart hook dispatch while preserving public-core context when paid work is unavailable or exhausted

### Changed
- Replace temporary unlimited email activation with a configurable free daily agent-session allowance keyed by normalized email
- Persist an activation credential only after the control plane accepts activation; reconstruct the free account-metered capability policy in trusted core code on every load
- Disclose the bounded D1 usage count and opaque SessionStart operation IDs on the activation page

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
