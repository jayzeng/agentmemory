# Changelog

All notable changes to this project will be documented in this file.

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
