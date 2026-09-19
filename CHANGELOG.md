# Changelog

All notable changes to this project will be documented in this file.

## 0.6.1

### Fixed

- `agent-memory serve --mcp` crashed in the actually-published npm package
  (`Cannot find module '.../dist/mcp-server.js'`) because `dist/mcp-server.js`
  and its `.d.ts` were never added to `package.json`'s publish `files`
  allowlist when the MCP server was added in 0.6.0. Every other test stayed
  green because they all ran against the local, unpacked `dist/` directly
  instead of the packed tarball. Added `dist/mcp-server.{js,d.ts}` to `files`
  and strengthened the npm-package-portability test to pack, install, and
  actually invoke `serve --mcp` against the real installed binary so this
  class of bug fails CI going forward.

## 0.6.0

### Added

- `agent-memory serve --mcp`: a real Model Context Protocol server over stdio
  (JSON-RPC 2.0, newline-delimited), exposing `memory_context`, `memory_search`,
  `memory_read`, `memory_write`, and `memory_scratchpad` as MCP tools backed by
  the same core read/write/search logic the CLI commands use. This is the
  local stdio server any MCP-capable harness (or a remote relay, for harnesses
  like ChatGPT that cannot spawn local subprocesses) can now spawn instead of
  shelling out to individual CLI commands.
- A generic external-command handoff: any CLI invocation that isn't a known
  Core command is now forwarded to a platform-correct external host binary
  next to the running CLI, if one exists, instead of just failing. This is
  what lets a separate, non-public companion add its own commands (e.g. `pro`)
  without Core needing to know about it.

### Changed

- Re-established AgentMemory as a standalone MIT-licensed local memory project.
- Removed account/device distribution integration and private service references from the public source tree.
- Added an automated public-source boundary check to CI and package publication.

### Fixed

- The npm package now ships and runs a portable Node.js CLI on Windows instead
  of assuming a POSIX-style native binary; external-command host-path
  resolution is platform-correct on Windows.

## 0.5.5

The last release before the public-source boundary reset. See repository history for earlier release notes.
