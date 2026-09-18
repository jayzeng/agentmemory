# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- `agent-memory serve --mcp`: a real Model Context Protocol server over stdio
  (JSON-RPC 2.0, newline-delimited), exposing `memory_context`, `memory_search`,
  `memory_read`, `memory_write`, and `memory_scratchpad` as MCP tools backed by
  the same core read/write/search logic the CLI commands use. This is the
  local stdio server any MCP-capable harness (or a remote relay, for harnesses
  like ChatGPT that cannot spawn local subprocesses) can now spawn instead of
  shelling out to individual CLI commands.

### Changed

- Re-established AgentMemory as a standalone MIT-licensed local memory project.
- Removed account/device distribution integration and private service references from the public source tree.
- Added an automated public-source boundary check to CI and package publication.

## 0.5.5

The last release before the public-source boundary reset. See repository history for earlier release notes.
