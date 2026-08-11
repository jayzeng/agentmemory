# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
