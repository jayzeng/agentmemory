/**
 * Unit tests for agent-memory CLI command handlers.
 *
 * Run:   bun test test/cli.test.ts
 *
 * Uses temp directories for all file I/O — does not touch real memory files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMANDS } from "../src/cli-spec.js";
import { generateCompletion } from "../src/completions.js";
import {
	_clearUpdateTimer,
	_resetBaseDir,
	_setBaseDir,
	_setQmdAvailable,
	buildMemoryContext,
	dailyPath,
	ensureDirs,
	getMemoryDir,
	getMemoryFile,
	getScratchpadFile,
	parseScratchpad,
	readFileSafe,
	serializeScratchpad,
	todayStr,
} from "../src/core.js";
import {
	_setHookHomeDirForTest,
	installHooks,
	isHookInstalled,
	isStopHookInstalled,
	isUserPromptSubmitInstalled,
	uninstallHooks,
} from "../src/hooks.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-cli-test-"));
	_setBaseDir(tmpDir);
	_setQmdAvailable(false);
	ensureDirs();
}

function cleanupTmpDir() {
	_clearUpdateTimer();
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

function installFakeQmd(source: string): string {
	const fakeBin = path.join(tmpDir, "bin");
	fs.mkdirSync(fakeBin, { recursive: true });
	const fakeQmd = path.join(fakeBin, "qmd");
	fs.writeFileSync(fakeQmd, `#!/usr/bin/env node\n${source}\n`, "utf-8");
	fs.chmodSync(fakeQmd, 0o755);
	return fakeBin;
}

// ---------------------------------------------------------------------------
// 1. Core functions work from core.ts imports
// ---------------------------------------------------------------------------

describe("core imports", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("getMemoryDir returns the set directory", () => {
		expect(getMemoryDir()).toBe(tmpDir);
	});

	test("getMemoryFile returns MEMORY.md path", () => {
		expect(getMemoryFile()).toBe(path.join(tmpDir, "MEMORY.md"));
	});

	test("getScratchpadFile returns SCRATCHPAD.md path", () => {
		expect(getScratchpadFile()).toBe(path.join(tmpDir, "SCRATCHPAD.md"));
	});

	test("ensureDirs creates directory structure", () => {
		expect(fs.existsSync(tmpDir)).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "daily"))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "topics"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. Write operations (simulating CLI write command)
// ---------------------------------------------------------------------------

describe("write operations", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("write to long_term creates MEMORY.md", () => {
		const memFile = getMemoryFile();
		const content = "User prefers dark mode";
		const stamped = `<!-- test-ts [cli] -->\n${content}`;
		fs.writeFileSync(memFile, stamped, "utf-8");

		const result = readFileSafe(memFile);
		expect(result).toContain("User prefers dark mode");
	});

	test("append to existing MEMORY.md", () => {
		const memFile = getMemoryFile();
		fs.writeFileSync(memFile, "Existing content", "utf-8");

		const existing = readFileSafe(memFile) ?? "";
		const separator = existing.trim() ? "\n\n" : "";
		const stamped = `<!-- ts [cli] -->\nNew content`;
		fs.writeFileSync(memFile, existing + separator + stamped, "utf-8");

		const result = readFileSafe(memFile)!;
		expect(result).toContain("Existing content");
		expect(result).toContain("New content");
	});

	test("overwrite MEMORY.md replaces content", () => {
		const memFile = getMemoryFile();
		fs.writeFileSync(memFile, "Old content", "utf-8");
		fs.writeFileSync(memFile, "<!-- last updated -->\nNew content", "utf-8");

		const result = readFileSafe(memFile)!;
		expect(result).toContain("New content");
		expect(result).not.toContain("Old content");
	});

	test("write to daily log", () => {
		const today = todayStr();
		const filePath = dailyPath(today);
		const stamped = `<!-- ts [cli] -->\nDid some work`;
		fs.writeFileSync(filePath, stamped, "utf-8");

		const result = readFileSafe(filePath)!;
		expect(result).toContain("Did some work");
	});

	test("append to existing daily log", () => {
		const today = todayStr();
		const filePath = dailyPath(today);
		fs.writeFileSync(filePath, "Morning entry", "utf-8");

		const existing = readFileSafe(filePath) ?? "";
		const separator = existing.trim() ? "\n\n" : "";
		fs.writeFileSync(filePath, `${existing + separator}Afternoon entry`, "utf-8");

		const result = readFileSafe(filePath)!;
		expect(result).toContain("Morning entry");
		expect(result).toContain("Afternoon entry");
	});
});

// ---------------------------------------------------------------------------
// 3. Read operations
// ---------------------------------------------------------------------------

describe("read operations", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("read long_term returns MEMORY.md content", () => {
		fs.writeFileSync(getMemoryFile(), "My memories", "utf-8");
		expect(readFileSafe(getMemoryFile())).toBe("My memories");
	});

	test("read long_term returns null when missing", () => {
		expect(readFileSafe(getMemoryFile())).toBeNull();
	});

	test("read scratchpad returns content", () => {
		const spFile = getScratchpadFile();
		fs.writeFileSync(spFile, "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		expect(readFileSafe(spFile)).toContain("Task");
	});

	test("read daily returns day's log", () => {
		const today = todayStr();
		const filePath = dailyPath(today);
		fs.writeFileSync(filePath, "Today's log", "utf-8");
		expect(readFileSafe(filePath)).toBe("Today's log");
	});

	test("list daily logs", () => {
		const dailyDir = path.join(tmpDir, "daily");
		fs.writeFileSync(path.join(dailyDir, "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(dailyDir, "2026-02-14.md"), "b", "utf-8");
		fs.writeFileSync(path.join(dailyDir, "notes.txt"), "c", "utf-8");

		const files = fs
			.readdirSync(dailyDir)
			.filter((f) => f.endsWith(".md"))
			.sort()
			.reverse();

		expect(files).toHaveLength(2);
		expect(files[0]).toBe("2026-02-15.md");
		expect(files[1]).toBe("2026-02-14.md");
	});
});

// ---------------------------------------------------------------------------
// 4. Scratchpad operations
// ---------------------------------------------------------------------------

describe("scratchpad operations", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("add item to empty scratchpad", () => {
		const spFile = getScratchpadFile();
		const items = [{ done: false, text: "Fix login bug", meta: "<!-- ts [cli] -->" }];
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");

		const content = readFileSafe(spFile)!;
		expect(content).toContain("Fix login bug");
		expect(content).toContain("[ ]");
	});

	test("mark item as done", () => {
		const spFile = getScratchpadFile();
		let items = [{ done: false, text: "Fix login bug", meta: "<!-- ts [cli] -->" }];
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");

		// Simulate done
		items = parseScratchpad(readFileSafe(spFile)!);
		const needle = "login";
		for (const item of items) {
			if (!item.done && item.text.toLowerCase().includes(needle)) {
				item.done = true;
				break;
			}
		}
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");

		const content = readFileSafe(spFile)!;
		expect(content).toContain("[x]");
	});

	test("clear done items", () => {
		const spFile = getScratchpadFile();
		const items = [
			{ done: false, text: "Keep this", meta: "" },
			{ done: true, text: "Remove this", meta: "" },
		];
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");

		const remaining = parseScratchpad(readFileSafe(spFile)!).filter((i) => !i.done);
		fs.writeFileSync(spFile, serializeScratchpad(remaining), "utf-8");

		const content = readFileSafe(spFile)!;
		expect(content).toContain("Keep this");
		expect(content).not.toContain("Remove this");
	});

	test("list items shows count", () => {
		const spFile = getScratchpadFile();
		const items = [
			{ done: false, text: "Open 1", meta: "" },
			{ done: false, text: "Open 2", meta: "" },
			{ done: true, text: "Done 1", meta: "" },
		];
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");

		const parsed = parseScratchpad(readFileSafe(spFile)!);
		expect(parsed).toHaveLength(3);
		expect(parsed.filter((i) => !i.done)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 5. Context building
// ---------------------------------------------------------------------------

describe("context building", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("empty context returns empty string", () => {
		expect(buildMemoryContext()).toBe("");
	});

	test("includes MEMORY.md content", () => {
		fs.writeFileSync(getMemoryFile(), "Important fact", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("Important fact");
		expect(ctx).toContain("# Memory");
	});

	test("includes today's daily log", () => {
		const today = todayStr();
		fs.writeFileSync(dailyPath(today), "Today's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("Today's work");
		expect(ctx).toContain("(today)");
	});

	test("includes open scratchpad items only", () => {
		const spFile = getScratchpadFile();
		fs.writeFileSync(spFile, "# Scratchpad\n\n- [ ] Open\n- [x] Done\n", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("Open");
		expect(ctx).not.toContain("Done");
	});

	test("includes search results when provided", () => {
		fs.writeFileSync(getMemoryFile(), "Memory", "utf-8");
		const ctx = buildMemoryContext("Search result XYZ");
		expect(ctx).toContain("Search result XYZ");
		expect(ctx).toContain("Relevant memories");
	});
});

// ---------------------------------------------------------------------------
// 6. CLI integration (subprocess tests)
// ---------------------------------------------------------------------------

describe("CLI subprocess", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("init creates directories", { timeout: 30_000 }, async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "init", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.directory).toBe(tmpDir);
	});

	test("hook user-prompt-submit emits dynamic-layer context from stdin JSON", { timeout: 15_000 }, () => {
		// Seed the memory dir: stable content (MEMORY.md, scratchpad) must be
		// EXCLUDED; dynamic content (today's daily log) must be INCLUDED.
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Durable fact", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task X\n", "utf-8");
		const today = new Date().toISOString().slice(0, 10);
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's dynamic entry", "utf-8");

		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"user-prompt-submit",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdin: Buffer.from(JSON.stringify({ user_input: "recent" })),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain(`## Daily log: ${today} (today)`);
		expect(stdout).toContain("Today's dynamic entry");
		expect(stdout).not.toContain("Durable fact");
		expect(stdout).not.toContain("Task X");
	});

	test("hook user-prompt-submit cancels a hanging qmd process at its timeout", { timeout: 12_000 }, async () => {
		const fakeBin = installFakeQmd('process.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1_000);');

		const startedAt = performance.now();
		const child = Bun.spawn(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"user-prompt-submit",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdin: Buffer.from(JSON.stringify({ user_input: "recent" })),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
					AGENT_MEMORY_PLUGIN_DIR: path.join(tmpDir, "plugins"),
					AGENT_MEMORY_QMD_UPDATE: "off",
					AGENT_MEMORY_QMD_EMBED: "off",
				},
			},
		);
		const exitCode = await child.exited;
		const elapsedMs = performance.now() - startedAt;

		expect(exitCode).toBe(0);
		expect(elapsedMs).toBeLessThan(6_000);
	});

	test("hook user-prompt-submit exits 0 with empty stdout on malformed stdin", { timeout: 15_000 }, () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"user-prompt-submit",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdin: Buffer.from("this is not json"),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
	});

	test("hook user-prompt-submit exits 0 with empty stdout on empty stdin", { timeout: 15_000 }, () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"user-prompt-submit",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdin: Buffer.from(""),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
	});

	test("hook session-start emits stable-layer only when hook mode is per-turn", { timeout: 15_000 }, () => {
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Durable fact", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task X\n", "utf-8");
		const today = new Date().toISOString().slice(0, 10);
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's dynamic entry", "utf-8");
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"session-start",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, AGENT_MEMORY_HOOK_MODE: "per-turn" },
			},
		);
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("Durable fact");
		expect(stdout).toContain("Task X");
		expect(stdout).not.toContain("Today's dynamic entry");
	});

	test("hook session-start emits full context in stable hook mode", { timeout: 15_000 }, () => {
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Durable fact", "utf-8");
		const today = new Date().toISOString().slice(0, 10);
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's dynamic entry", "utf-8");
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"session-start",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, AGENT_MEMORY_HOOK_MODE: "stable" },
			},
		);
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("Durable fact");
		expect(stdout).toContain("Today's dynamic entry");
	});

	function runHookStop(sessionId: string, stopHookActive = false) {
		return Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"stop",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{
				stdin: Buffer.from(JSON.stringify({ session_id: sessionId, stop_hook_active: stopHookActive })),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	}

	test("hook stop only nags every STOP_NAG_INTERVAL (12) turns per session", { timeout: 20_000 }, () => {
		const sessionId = "session-a";
		for (let turn = 1; turn <= 11; turn++) {
			const result = runHookStop(sessionId);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toBe("");
		}
		const twelfth = runHookStop(sessionId);
		expect(twelfth.exitCode).toBe(0);
		const decision = JSON.parse(twelfth.stdout.toString());
		expect(decision.decision).toBe("block");
		expect(typeof decision.reason).toBe("string");
		expect(decision.reason.length).toBeGreaterThan(0);

		// Counter resets relative to the last nag — turns 13-23 stay quiet, 24 nags again.
		for (let turn = 13; turn <= 23; turn++) {
			expect(runHookStop(sessionId).stdout.toString()).toBe("");
		}
		const twentyFourth = runHookStop(sessionId);
		expect(JSON.parse(twentyFourth.stdout.toString()).decision).toBe("block");
	});

	test("hook stop never nags twice in a row when stop_hook_active is true", { timeout: 15_000 }, () => {
		const sessionId = "session-b";
		for (let turn = 1; turn <= 12; turn++) {
			runHookStop(sessionId, true);
		}
		// Even after 12 calls, stop_hook_active always short-circuits to "allow".
		const result = runHookStop(sessionId, true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
	});

	test("hook stop tracks each session_id independently", { timeout: 15_000 }, () => {
		for (let turn = 1; turn <= 11; turn++) {
			expect(runHookStop("session-c").stdout.toString()).toBe("");
		}
		// A different session starts its own counter from zero.
		expect(runHookStop("session-d").stdout.toString()).toBe("");
	});

	test("hook stop exits 0 with empty stdout on missing session_id", { timeout: 15_000 }, () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"hook",
				"stop",
				"--agent",
				"claude",
				"--dir",
				tmpDir,
			],
			{ stdin: Buffer.from(JSON.stringify({})), stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
	});

	test("serve --mcp initializes with the package version and lists Core tools", { timeout: 15_000 }, () => {
		const requests = [
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
		];
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "serve", "--mcp", "--dir", tmpDir],
			{
				stdin: Buffer.from(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		const responses = result.stdout
			.toString()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(responses[0]?.result.serverInfo).toEqual({ name: "agent-memory", version: "0.5.1" });
		const toolNames = responses[1]?.result.tools.map((tool: { name: string }) => tool.name);
		expect(toolNames).toContain("memory_read");
		expect(toolNames).toContain("memory_write");
	});

	test("serve --mcp routes scratchpad writes through Core secret screening", { timeout: 15_000 }, () => {
		const token = "sk-eval-DO-NOT-USE-1234567890abcdef";
		const request = {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "memory_write", arguments: { target: "scratchpad", content: `Use ${token}` } },
		};
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "serve", "--mcp", "--dir", tmpDir],
			{
				stdin: Buffer.from(`${JSON.stringify(request)}\n`),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).not.toContain(token);
		const scratchpad = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(scratchpad).not.toContain(token);
		expect(scratchpad).toContain("[REDACTED_SECRET]");
	});

	test("serve --mcp screens legacy secrets before returning memory", { timeout: 15_000 }, () => {
		const token = "sk-eval-DO-NOT-USE-1234567890abcdef";
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), `# Memory\n\nUse ${token}\n`);
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), `# Scratchpad\n\n- [ ] Rotate ${token}\n`);
		const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_read", arguments: {} } };
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "serve", "--mcp", "--dir", tmpDir],
			{
				stdin: Buffer.from(`${JSON.stringify(request)}\n`),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).not.toContain(token);
		expect(result.stdout.toString()).toContain("[REDACTED_SECRET]");
	});

	test("status shows config", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "status", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.directory).toBe(tmpDir);
		expect(out.dailyLogs).toBe(0);
		expect(out.topics).toBe(0);
		// Live embeddings probe is opt-in (--probe), so it never runs here.
		expect(out.qmd.embeddings).toBe("n/a");
	});

	test("write and read round-trip", async () => {
		// Write
		const writeResult = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--target",
				"long_term",
				"--content",
				"Test content",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(writeResult.exitCode).toBe(0);
		const writeOut = JSON.parse(writeResult.stdout.toString());
		expect(writeOut.ok).toBe(true);

		// Read
		const readResult = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"read",
				"--dir",
				tmpDir,
				"--target",
				"long_term",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(readResult.exitCode).toBe(0);
		const readOut = JSON.parse(readResult.stdout.toString());
		expect(readOut.content).toContain("Test content");
	});

	test("CLI write uses the core provenance and secret-safety boundary", () => {
		const token = "sk-eval-DO-NOT-USE-1234567890abcdef";
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--target",
				"long_term",
				"--content",
				`Token: ${token}`,
				"--source-uri",
				"session://codex/session-1/turn/4",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout.toString());
		expect(output.redacted).toBe(true);
		const stored = fs.readFileSync(getMemoryFile(), "utf-8");
		expect(stored).toContain("Source: session://codex/session-1/turn/4");
		expect(stored).toContain("[REDACTED_SECRET]");
		expect(stored).not.toContain(token);
	});

	test("write and read topic round-trip", async () => {
		const writeResult = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--target",
				"topic",
				"--topic",
				"auth",
				"--content",
				"JWT refresh rolled out #auth",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(writeResult.exitCode).toBe(0);
		const writeOut = JSON.parse(writeResult.stdout.toString());
		expect(writeOut.ok).toBe(true);

		const readResult = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"read",
				"--dir",
				tmpDir,
				"--target",
				"topic",
				"--topic",
				"auth",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(readResult.exitCode).toBe(0);
		const readOut = JSON.parse(readResult.stdout.toString());
		expect(readOut.content).toContain("JWT refresh rolled out");
	});

	test("context returns memory content", async () => {
		// Write some memory first
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Context test memory", "utf-8");
		fs.writeFileSync(
			path.join(tmpDir, "topics", "auth.md"),
			[
				"# Topic: Auth",
				"<!-- created: 2026-02-21 09:00:00 [init] -->",
				"",
				"<!-- 2026-02-21 10:00:00 [abc] -->",
				"Rolled JWT refresh to edge #auth",
				"Daily: [[2026-02-21]]",
			].join("\n"),
			"utf-8",
		);

		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"context",
				"--dir",
				tmpDir,
				"--no-search",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.context).toContain("Context test memory");
		expect(out.context).toContain("## Topics (recent)");
	});

	test("scratchpad add and list round-trip", async () => {
		// Add
		const addResult = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"scratchpad",
				"add",
				"--dir",
				tmpDir,
				"--text",
				"Test task",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(addResult.exitCode).toBe(0);
		const addOut = JSON.parse(addResult.stdout.toString());
		expect(addOut.ok).toBe(true);

		// List
		const listResult = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "scratchpad", "list", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(listResult.exitCode).toBe(0);
		const listOut = JSON.parse(listResult.stdout.toString());
		expect(listOut.count).toBe(1);
		expect(listOut.items[0].text).toBe("Test task");
	});

	test("scratchpad add never echoes recognized secrets", () => {
		const token = "sk-eval-DO-NOT-USE-1234567890abcdef";
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"scratchpad",
				"add",
				"--dir",
				tmpDir,
				"--text",
				`Token ${token}`,
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(stdout).toContain("[REDACTED_SECRET]");
		expect(stdout).not.toContain(token);
	});

	test("scratchpad commands redact legacy secrets", () => {
		const token = "sk-eval-DO-NOT-USE-1234567890abcdef";
		fs.writeFileSync(
			getScratchpadFile(),
			`# Scratchpad\n\n<!-- 2026-01-02 12:00:00 [old] -->\n- [ ] Legacy token ${token}\n`,
			"utf-8",
		);
		const listResult = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "scratchpad", "list", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const listStdout = listResult.stdout.toString();
		expect(listResult.exitCode).toBe(0);
		expect(listStdout).toContain("[REDACTED_SECRET]");
		expect(listStdout).not.toContain(token);

		const addResult = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"scratchpad",
				"add",
				"--dir",
				tmpDir,
				"--text",
				"Safe follow-up",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(addResult.exitCode).toBe(0);
		const stored = fs.readFileSync(getScratchpadFile(), "utf-8");
		expect(stored).toContain("[REDACTED_SECRET]");
		expect(stored).not.toContain(token);
	});

	test("help shows usage", async () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const out = result.stdout.toString();
		expect(out).toContain("agent-memory");
		// Grouped-help sections replaced the single "Commands:" header
		expect(out).toContain("Do things:");
		expect(out).toContain("Setup:");
		expect(out).toContain("Pro:");
		for (const command of COMMANDS) expect(out).toMatch(new RegExp(`^  ${command}\\s{2,}`, "m"));
		expect(out).not.toMatch(/^\t/m);
	});

	test("plugin discovery is structured and does not expose install paths", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin", "list", "--json"],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		const out = JSON.parse(stdout);
		expect(out.schemaVersion).toBe(1);
		expect(out.command).toBe("plugin.list");
		expect(out.result).toBe("not_installed");
		expect(out.plugins.map((plugin: { id: string }) => plugin.id)).toEqual([
			"agentmemory.session-intelligence",
			"agentmemory.web-console",
		]);
		expect(stdout).not.toContain(pluginDir);
	});

	test("plugin discovery explains Pro value and the installation next step", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin"], {
			env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("Core remembers what you save. Pro learns from what you do.");
		expect(stdout).toContain("Remember past sessions");
		expect(stdout).toContain("Learn from your patterns");
		expect(stdout).toContain("Private by default");
		expect(stdout).toContain("No account. No email.");
		expect(stdout).toContain("agent-memory pro install");
	});

	test("non-interactive plugin install attempts anonymous preview access without requiring identity", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(
			[
				"bun",
				"--preload",
				path.join(__dirname, "fixtures", "plugin-service-unavailable.ts"),
				path.join(__dirname, "..", "src", "cli.ts"),
				"plugin",
				"install",
				"--json",
			],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(1);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(false);
		expect(out.result).toBe("unavailable");
		expect(out.error.code).not.toBe("auth_required");
		expect(out.nextAction).toBeNull();
		expect(fs.existsSync(pluginDir)).toBe(false);
	});

	test("plugin uninstall requires explicit confirmation", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin", "uninstall", "--json"],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(1);
		const out = JSON.parse(result.stdout.toString());
		expect(out.command).toBe("plugin.uninstall");
		expect(out.error.code).toBe("confirmation_required");
		expect(fs.existsSync(pluginDir)).toBe(false);
	});

	test("plugin errors retain the structured envelope for corrupt local state", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		fs.mkdirSync(path.join(pluginDir, "receipts"), { recursive: true });
		fs.writeFileSync(path.join(pluginDir, "receipts", "agentmemory.pro.json"), "not-json");
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin", "status", "--json"],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(1);
		const out = JSON.parse(result.stdout.toString());
		expect(out.schemaVersion).toBe(1);
		expect(out.command).toBe("plugin.status");
		expect(out.error.code).toBe("receipt_invalid");
	});

	test("plugin option errors use the structured envelope", () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"plugin",
				"install",
				"--channel",
				"nightly",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(1);
		const out = JSON.parse(result.stdout.toString());
		expect(out.command).toBe("plugin.install");
		expect(out.error.code).toBe("channel_invalid");
	});

	test("plugin help documents the free daily allowance", () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const out = result.stdout.toString();
		expect(out).toContain("agent-memory plugin install");
		expect(out).toContain("20 recalls and 5 learning scans per local day");
	});

	test("Pro status delegates to the low-level bootstrap contract", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "pro", "status", "--json"],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.command).toBe("plugin.status");
		expect(out.result).toBe("not_installed");
	});

	test("unknown command exits with error", async () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "invalid", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
	});

	test("typo in command name suggests the correct one", async () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "reed", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Did you mean 'read'");
	});

	test("unknown flag on write is rejected (not silently ignored)", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--taget",
				"long_term",
				"--content",
				"should not persist",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(1);
		const stderr = result.stderr.toString();
		expect(stderr).toContain("Unknown flag --taget");
		expect(stderr).toContain("Did you mean --target?");
	});

	test("unknown flag on search suggests --query", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "search", "--dir", tmpDir, "--qeury", "test"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Did you mean --query?");
	});

	test("search --json emits a source field distinguishing qmd from recall fallback", () => {
		const fakeBin = installFakeQmd(
			'const args = process.argv.slice(2);\nif (args[0] === "collection") console.log(JSON.stringify([{ name: "agent-memory" }]));\nelse if (args.includes("query")) console.log("[]");',
		);
		const pluginDir = path.join(tmpDir, "plugin-install"); // empty → Pro absent → fallback no-op
		const unique = "agent-memory-fallback-test-nonexistent-token-xzxzxz";
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"search",
				"--query",
				unique,
				"--mode",
				"keyword",
				"--json",
			],
			{
				env: {
					...process.env,
					PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
					AGENT_MEMORY_PLUGIN_DIR: pluginDir,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);

		const out = JSON.parse(result.stdout.toString());
		expect(out.mode).toBe("keyword");
		expect(out.query).toBe(unique);
		expect(out.source).toBe("qmd"); // Pro disabled → source stays "qmd"
		expect(out.count).toBe(0);
		expect(Array.isArray(out.results)).toBe(true);
	});

	test("search prints standard no-hit message when qmd is empty and Pro is absent", () => {
		const fakeBin = installFakeQmd(
			'const args = process.argv.slice(2);\nif (args[0] === "collection") console.log(JSON.stringify([{ name: "agent-memory" }]));\nelse if (args.includes("query")) console.log("[]");',
		);
		const pluginDir = path.join(tmpDir, "plugin-install");
		const unique = "agent-memory-fallback-test-nonexistent-token-yzyzyz";
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "search", "--query", unique, "--mode", "keyword"],
			{
				env: {
					...process.env,
					PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
					AGENT_MEMORY_PLUGIN_DIR: pluginDir,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);

		const stdout = result.stdout.toString();
		// With Pro absent the fallback is a silent no-op and we fall back to the standard message.
		expect(stdout).toContain(`No results found for "${unique}"`);
		expect(stdout).not.toContain("falling back to prior sessions");
	});

	test("global --json flag is accepted on all commands", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "status", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
	});

	test("save preserves --tokens inside content", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"save",
				"add --dry-run flag to distil",
				"--dir",
				tmpDir,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const read = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "read", "--target", "daily", "--dir", tmpDir],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(read.stdout.toString()).toContain("add --dry-run flag to distil");
	});

	test("save honors trailing --target flag while preserving literal --target in content", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"save",
				"literal --target long_term text",
				"--target",
				"long_term",
				"--dir",
				tmpDir,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const read = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "read", "--target", "long_term", "--dir", tmpDir],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(read.stdout.toString()).toContain("literal --target long_term text");
	});

	test("note preserves --tokens as scratchpad text", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"note",
				"fix the --no-verify hook",
				"--dir",
				tmpDir,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const list = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "scratchpad", "list", "--dir", tmpDir],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(list.stdout.toString()).toContain("fix the --no-verify hook");
	});

	test("doctor exits 0 when everything is fine", { timeout: 30_000 }, async () => {
		const seededDir = path.join(tmpDir, "doctor-ok");
		// Seed MEMORY.md so it isn't the empty-warn path
		Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--target",
				"long_term",
				"--content",
				"first fact",
				"--dir",
				seededDir,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "doctor", "--dir", seededDir],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect([0, 1]).toContain(result.exitCode); // 1 acceptable if plugin unavailable in CI
		const output = result.stdout.toString();
		expect(output).toContain("AgentMemory diagnostic");
		// Verify no duplicate Pro row from the earlier double-row bug
		const proMatches = output.match(/AgentMemory Pro/g);
		expect(proMatches?.length ?? 0).toBeLessThanOrEqual(1);
	});

	test("doctor --json emits structured rows", { timeout: 30_000 }, async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "doctor", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const output = JSON.parse(result.stdout.toString()) as { rows: Array<{ status: string; label: string }> };
		expect(Array.isArray(output.rows)).toBe(true);
		expect(output.rows.length).toBeGreaterThan(0);
		expect(output.rows.some((row) => row.label === "Memory directory")).toBe(true);
	});

	test("doctor reports Stop nudge status for Claude Code", { timeout: 30_000 }, () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-doctor-home-"));
		try {
			fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
			fs.writeFileSync(path.join(fakeHome, ".claude", "settings.json"), "{}");

			const before = Bun.spawnSync(
				["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "doctor", "--dir", tmpDir, "--json"],
				{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fakeHome } },
			);
			const beforeRows = JSON.parse(before.stdout.toString()).rows as Array<{ label: string; detail: string }>;
			const beforeRow = beforeRows.find((row) => row.label === "Hook: Claude Code");
			expect(beforeRow?.detail).toContain("Stop memory-write nudge missing");

			Bun.spawnSync(
				["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "install-hooks", "--only", "claude", "--yes"],
				{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fakeHome } },
			);

			const after = Bun.spawnSync(
				["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "doctor", "--dir", tmpDir, "--json"],
				{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: fakeHome } },
			);
			const afterRows = JSON.parse(after.stdout.toString()).rows as Array<{ label: string; detail: string }>;
			const afterRow = afterRows.find((row) => row.label === "Hook: Claude Code");
			expect(afterRow?.detail).toContain("Stop memory-write nudge active");
		} finally {
			fs.rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	test("sync command runs without crash", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "sync", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		// May fail if qmd not installed — that's fine, just shouldn't crash unexpectedly
		// exitCode 1 is acceptable (qmd not found), we just check it doesn't throw
		expect(result.exitCode === 0 || result.exitCode === 1).toBe(true);
	});

	test("status --json includes embedMode field", async () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "status", "--dir", tmpDir, "--json"],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.embedMode).toBeDefined();
		expect(["background", "manual", "off"]).toContain(out.embedMode);
		expect(out.officialPlugin).toEqual({ installed: false, result: "not_installed", entitlement: "missing" });
	});

	test("pro preview counts local sessions before the Pro bundle is installed", async () => {
		const pluginDir = path.join(tmpDir, "plugin-preview");
		const claudeRoot = path.join(tmpDir, "sessions", "claude");
		const codexRoot = path.join(tmpDir, "sessions", "codex");
		const piRoot = path.join(tmpDir, "sessions", "pi");
		fs.mkdirSync(path.join(claudeRoot, "project"), { recursive: true });
		fs.mkdirSync(codexRoot, { recursive: true });
		fs.mkdirSync(piRoot, { recursive: true });
		fs.writeFileSync(path.join(claudeRoot, "project", "one.jsonl"), "{}\n");
		fs.writeFileSync(path.join(claudeRoot, "project", "two.jsonl"), "{}\n");
		fs.writeFileSync(path.join(codexRoot, "three.jsonl"), "{}\n");

		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "pro", "preview", "--json"],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					AGENT_MEMORY_PLUGIN_DIR: pluginDir,
					AGENT_MEMORY_CLAUDE_SESSION_ROOT: claudeRoot,
					AGENT_MEMORY_CODEX_SESSION_ROOT: codexRoot,
					AGENT_MEMORY_PI_SESSION_ROOT: piRoot,
				},
			},
		);

		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out).toMatchObject({
			available: true,
			sessions: { claude: 2, codex: 1, pi: 0 },
			discovered: 3,
			previewed: 3,
		});
		expect(out.cap.limit).toBe(50);
		expect(out.cap.used).toBe(3);
	});

	test("pro preview enforces a local daily session cap without a bundle", async () => {
		const pluginDir = path.join(tmpDir, "plugin-preview-cap");
		const claudeRoot = path.join(tmpDir, "sessions-cap", "claude");
		const codexRoot = path.join(tmpDir, "sessions-cap", "codex");
		const piRoot = path.join(tmpDir, "sessions-cap", "pi");
		fs.mkdirSync(claudeRoot, { recursive: true });
		fs.mkdirSync(codexRoot, { recursive: true });
		fs.mkdirSync(piRoot, { recursive: true });
		for (let index = 0; index < 55; index++) {
			fs.writeFileSync(path.join(claudeRoot, `${index}.jsonl`), "{}\n");
		}
		const env = {
			...process.env,
			AGENT_MEMORY_PLUGIN_DIR: pluginDir,
			AGENT_MEMORY_CLAUDE_SESSION_ROOT: claudeRoot,
			AGENT_MEMORY_CODEX_SESSION_ROOT: codexRoot,
			AGENT_MEMORY_PI_SESSION_ROOT: piRoot,
		};

		const first = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "pro", "preview", "--json"],
			{ stdout: "pipe", stderr: "pipe", env },
		);
		const second = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "pro", "preview", "--json"],
			{ stdout: "pipe", stderr: "pipe", env },
		);

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		const firstOut = JSON.parse(first.stdout.toString());
		const secondOut = JSON.parse(second.stdout.toString());
		expect(firstOut.previewed).toBe(50);
		expect(firstOut.cap).toMatchObject({ limit: 50, used: 50, remaining: 0, exhausted: false });
		expect(secondOut.previewed).toBe(0);
		expect(secondOut.cap).toMatchObject({ limit: 50, used: 50, remaining: 0, exhausted: true });
	});

	test("install-skills --uninstall removes SKILL.md from home", async () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-home-cli-uninstall-"));

		// Install a skill first
		const skillDir = path.join(homeDir, ".claude", "skills", "agent-memory");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Claude", "utf-8");

		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "install-skills", "--uninstall", "--json"],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: homeDir },
			},
		);

		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.removed.length).toBe(1);
		expect(out.removed[0].label).toBe("Claude Code skill");
		expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(false);

		fs.rmSync(homeDir, { recursive: true, force: true });
	});

	test("install-skills copies SKILL.md into home", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-skill-cli-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-home-cli-"));

		fs.mkdirSync(path.join(projectDir, "skills", "claude-code"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "skills", "claude-code", "SKILL.md"), "# Claude", "utf-8");
		fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
		// Detect via a marker file so the test does not depend on a `claude` binary being on PATH.
		fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), "{}", "utf-8");

		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "install-skills", "--json"],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: homeDir,
					AGENT_MEMORY_SKILLS_ROOT: projectDir,
				},
			},
		);

		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.detected.length).toBe(1);
		expect(fs.existsSync(path.join(homeDir, ".claude", "skills", "agent-memory", "SKILL.md"))).toBe(true);

		fs.rmSync(projectDir, { recursive: true, force: true });
		fs.rmSync(homeDir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// 7. Default write target (CLI subprocess)
// ---------------------------------------------------------------------------

describe("CLI default write target", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("write without --target defaults to daily", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--content",
				"Default target test",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.target).toBe("daily");

		// Verify file was written to daily directory
		const today = todayStr();
		const dailyContent = readFileSafe(dailyPath(today));
		expect(dailyContent).toContain("Default target test");
	});

	test("write with --target long_term still works", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--target",
				"long_term",
				"--content",
				"Long-term test",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.target).toBe("long_term");
	});

	test("write with invalid --target errors", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				path.join(__dirname, "..", "src", "cli.ts"),
				"write",
				"--dir",
				tmpDir,
				"--target",
				"invalid",
				"--content",
				"test",
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 8. Distil command (CLI subprocess)
// ---------------------------------------------------------------------------

describe("CLI distil command", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("distil --dry-run --json returns result without writing", async () => {
		// Create a daily log
		const dailyDir = path.join(tmpDir, "daily");
		fs.writeFileSync(
			path.join(dailyDir, "2026-02-20.md"),
			"<!-- 2026-02-20 10:00:00 [abc] -->\nFixed auth bug #auth",
			"utf-8",
		);

		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "distil", "--dir", tmpDir, "--dry-run", "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.dryRun).toBe(true);
		expect(out.totalEntries).toBe(1);
		expect(out.output).toContain("# Memory Index");

		// MEMORY.md should not exist (dry run)
		expect(readFileSafe(path.join(tmpDir, "MEMORY.md"))).toBeNull();
	});

	test("distil --json writes MEMORY.md", async () => {
		const dailyDir = path.join(tmpDir, "daily");
		fs.writeFileSync(
			path.join(dailyDir, "2026-02-20.md"),
			"<!-- 2026-02-20 10:00:00 [abc] -->\nFixed bug #testing",
			"utf-8",
		);

		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "distil", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.dryRun).toBe(false);

		// MEMORY.md should now exist
		const content = readFileSafe(path.join(tmpDir, "MEMORY.md"));
		expect(content).not.toBeNull();
		expect(content).toContain("# Memory Index");
	});

	test("distill (double-l) also works", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "distill", "--dir", tmpDir, "--dry-run", "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
	});

	test("distil with no daily logs", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "distil", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.totalEntries).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 9. Install scripts
// ---------------------------------------------------------------------------

describe("install scripts", () => {
	let tmpHome: string;
	const repoRoot = path.join(__dirname, "..");

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-home-"));
	});

	afterEach(() => {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	test("install-skills.sh --uninstall removes skill files from HOME", () => {
		// Install first
		fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
		// Detect via marker files so the test does not depend on `claude`/`codex` binaries on PATH.
		fs.writeFileSync(path.join(tmpHome, ".claude", "settings.json"), "{}", "utf-8");
		fs.writeFileSync(path.join(tmpHome, ".codex", "config.toml"), "", "utf-8");

		const installResult = Bun.spawnSync(["bash", path.join(repoRoot, "scripts", "install-skills.sh")], {
			cwd: repoRoot,
			env: { ...process.env, HOME: tmpHome },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(installResult.exitCode).toBe(0);
		expect(fs.existsSync(path.join(tmpHome, ".claude", "skills", "agent-memory", "SKILL.md"))).toBe(true);

		// Uninstall
		const result = Bun.spawnSync(["bash", path.join(repoRoot, "scripts", "install-skills.sh"), "--uninstall"], {
			cwd: repoRoot,
			env: { ...process.env, HOME: tmpHome },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("Uninstall");

		expect(fs.existsSync(path.join(tmpHome, ".claude", "skills", "agent-memory", "SKILL.md"))).toBe(false);
		expect(fs.existsSync(path.join(tmpHome, ".codex", "skills", "agent-memory", "SKILL.md"))).toBe(false);
	});

	test("install-skills.sh copies skill files into HOME", () => {
		fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".cursor"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".agents"), { recursive: true });
		// Detect via marker files so the test does not depend on `claude`/`codex` binaries on PATH.
		fs.writeFileSync(path.join(tmpHome, ".claude", "settings.json"), "{}", "utf-8");
		fs.writeFileSync(path.join(tmpHome, ".codex", "config.toml"), "", "utf-8");

		const result = Bun.spawnSync(["bash", path.join(repoRoot, "scripts", "install-skills.sh")], {
			cwd: repoRoot,
			env: { ...process.env, HOME: tmpHome },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);

		const cases: Array<{ src: string; dest: string }> = [
			{
				src: path.join(repoRoot, "skills", "claude-code", "SKILL.md"),
				dest: path.join(tmpHome, ".claude", "skills", "agent-memory", "SKILL.md"),
			},
			{
				src: path.join(repoRoot, "skills", "codex", "SKILL.md"),
				dest: path.join(tmpHome, ".codex", "skills", "agent-memory", "SKILL.md"),
			},
			{
				src: path.join(repoRoot, "skills", "cursor", "SKILL.md"),
				dest: path.join(tmpHome, ".cursor", "skills", "agent-memory", "SKILL.md"),
			},
			{
				src: path.join(repoRoot, "skills", "agent", "SKILL.md"),
				dest: path.join(tmpHome, ".agents", "skills", "agent-memory", "SKILL.md"),
			},
		];

		for (const c of cases) {
			expect(fs.existsSync(c.dest)).toBe(true);
			const src = fs.readFileSync(c.src, "utf-8");
			const dest = fs.readFileSync(c.dest, "utf-8");
			expect(dest).toBe(src);
		}
	});
});

// ---------------------------------------------------------------------------
// 10. Core-owned hooks and completion
// ---------------------------------------------------------------------------

describe("core-owned hooks and completion", () => {
	test("completion advertises bootstrap commands without private implementation commands", () => {
		const bash = generateCompletion("bash");
		expect(bash).toContain("completion");
		expect(bash).toContain("install-hooks");
		expect(bash).toContain("list status install update uninstall manage");
		expect(bash).not.toContain("recall learn eval");
	});

	test("zsh completion escapes apostrophes in descriptions", () => {
		const zsh = generateCompletion("zsh");
		expect(zsh).toContain("--skip-skills[init: don'\\''t prompt to install agent skills]");
		expect(zsh).not.toContain("--skip-skills[init: don't prompt to install agent skills]");
	});

	test("managed Claude hook is idempotent and uninstall preserves unrelated hooks", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }] } }),
			);
			expect(installHooks(new Set(["claude"])).results[0]?.installed).toBe(true);
			expect(installHooks(new Set(["claude"])).results[0]?.reason).toBe("already installed");
			expect(uninstallHooks(new Set(["claude"])).results[0]?.installed).toBe(true);
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("echo keep");
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("fresh Claude hook install writes no matcher field and removes a legacy PreCompact hook", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					hooks: {
						PreCompact: [
							{
								hooks: [
									{
										type: "command",
										command: "agent-memory hook pre-compact --agent claude",
										_agentMemory: true,
									},
								],
							},
						],
					},
				}),
			);
			expect(installHooks(new Set(["claude"])).results[0]?.installed).toBe(true);
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(settings.hooks.PreCompact).toBeUndefined();
			const group = settings.hooks.SessionStart.find(
				(g: Record<string, unknown>) =>
					Array.isArray(g.hooks) && (g.hooks as Record<string, unknown>[]).some((h) => h._agentMemory === true),
			);
			expect(group).toBeDefined();
			expect(group.matcher).toBeUndefined();
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("re-install repairs stale matcher on existing Claude hook entry", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			// Simulate an older install that wrote matcher: "startup|resume"
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					hooks: {
						SessionStart: [
							{
								matcher: "startup|resume",
								hooks: [
									{
										type: "command",
										command: "agent-memory hook session-start --agent claude",
										_agentMemory: true,
									},
								],
							},
						],
					},
				}),
			);
			const result = installHooks(new Set(["claude"])).results[0];
			expect(result?.installed).toBe(true);
			expect(result?.reason).toBe("updated");
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			const group = settings.hooks.SessionStart[0];
			expect(group.matcher).toBeUndefined();
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("per-turn install writes both SessionStart and UserPromptSubmit for Claude", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-mem-"));
		try {
			_setHookHomeDirForTest(home);
			_setBaseDir(memDir);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, JSON.stringify({}));
			const report = installHooks(new Set(["claude"]), "per-turn");
			expect(report.results[0]?.installed).toBe(true);
			expect(report.results[0]?.mode).toBe("per-turn");
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			// Both groups exist and carry the marker.
			const sessionGroup = settings.hooks.SessionStart.find(
				(g: Record<string, unknown>) =>
					Array.isArray(g.hooks) && (g.hooks as Record<string, unknown>[]).some((h) => h._agentMemory === true),
			);
			const promptGroup = settings.hooks.UserPromptSubmit.find(
				(g: Record<string, unknown>) =>
					Array.isArray(g.hooks) && (g.hooks as Record<string, unknown>[]).some((h) => h._agentMemory === true),
			);
			expect(sessionGroup).toBeDefined();
			expect(promptGroup).toBeDefined();
			expect(sessionGroup.hooks[0].command).toBe("agent-memory hook session-start --agent claude");
			expect(promptGroup.hooks[0].command).toBe("agent-memory hook user-prompt-submit --agent claude");
			// Hook mode persisted.
			const config = JSON.parse(fs.readFileSync(path.join(memDir, "hook-config.json"), "utf-8"));
			expect(config).toEqual({ mode: "per-turn" });
			// isUserPromptSubmitInstalled sees it.
			expect(isUserPromptSubmitInstalled(home, "claude")).toBe(true);
			expect(isHookInstalled(home, "claude")).toBe(true);
			// Re-install is idempotent.
			expect(installHooks(new Set(["claude"]), "per-turn").results[0]?.reason).toBe("already installed");
		} finally {
			_setHookHomeDirForTest(null);
			_resetBaseDir();
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(memDir, { recursive: true, force: true });
		}
	});

	test("install writes a Stop group for Claude, independent of mode", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-mem-"));
		try {
			_setHookHomeDirForTest(home);
			_setBaseDir(memDir);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, JSON.stringify({}));

			// Stable mode still gets Stop — it backs memory writes, not per-turn
			// context injection, so it isn't gated by the mode toggle.
			installHooks(new Set(["claude"]), "stable");
			const stableSettings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(stableSettings.hooks.Stop[0].hooks[0].command).toBe("agent-memory hook stop --agent claude");
			expect(stableSettings.hooks.PreCompact).toBeUndefined();
			expect(isStopHookInstalled(home, "claude")).toBe(true);

			// Idempotent re-install, including a mode switch, doesn't duplicate it.
			installHooks(new Set(["claude"]), "per-turn");
			const perTurnSettings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(perTurnSettings.hooks.Stop).toHaveLength(1);
		} finally {
			_setHookHomeDirForTest(null);
			_resetBaseDir();
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(memDir, { recursive: true, force: true });
		}
	});

	test("uninstall removes the managed Stop group and preserves unrelated hooks", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] } }),
			);
			installHooks(new Set(["claude"]));
			expect(isStopHookInstalled(home, "claude")).toBe(true);

			expect(uninstallHooks(new Set(["claude"])).results[0]?.installed).toBe(true);
			expect(isStopHookInstalled(home, "claude")).toBe(false);
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo keep");
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("stable mode omits UserPromptSubmit and downgrade removes an existing one", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-mem-"));
		try {
			_setHookHomeDirForTest(home);
			_setBaseDir(memDir);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, JSON.stringify({}));
			// First install per-turn — both hooks present.
			installHooks(new Set(["claude"]), "per-turn");
			expect(isUserPromptSubmitInstalled(home, "claude")).toBe(true);
			// Now downgrade to stable — UserPromptSubmit managed entry must be removed.
			const report = installHooks(new Set(["claude"]), "stable");
			expect(report.results[0]?.installed).toBe(true);
			expect(report.results[0]?.mode).toBe("stable");
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(settings.hooks.UserPromptSubmit).toBeUndefined();
			expect(isUserPromptSubmitInstalled(home, "claude")).toBe(false);
			expect(isHookInstalled(home, "claude")).toBe(true);
			// Config mode reflects downgrade.
			const config = JSON.parse(fs.readFileSync(path.join(memDir, "hook-config.json"), "utf-8"));
			expect(config.mode).toBe("stable");
		} finally {
			_setHookHomeDirForTest(null);
			_resetBaseDir();
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(memDir, { recursive: true, force: true });
		}
	});

	test("per-turn Codex install writes both TOML sections within one marker block", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-mem-"));
		try {
			_setHookHomeDirForTest(home);
			_setBaseDir(memDir);
			// Create ~/.codex so detectHookAgents picks it up.
			fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
			fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
			const report = installHooks(new Set(["codex"]), "per-turn");
			expect(report.results[0]?.installed).toBe(true);
			const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
			expect(toml).toContain("# BEGIN agent-memory hook");
			expect(toml).toContain("# END agent-memory hook");
			expect(toml).toContain("[[hooks.SessionStart]]");
			expect(toml).toContain("[[hooks.UserPromptSubmit]]");
			expect(toml).toContain('command = "agent-memory hook session-start --agent codex"');
			expect(toml).toContain('command = "agent-memory hook user-prompt-submit --agent codex"');
			// Both markers appear exactly once (single BEGIN/END pair).
			expect(toml.split("# BEGIN agent-memory hook").length - 1).toBe(1);
			expect(toml.split("# END agent-memory hook").length - 1).toBe(1);
			expect(isUserPromptSubmitInstalled(home, "codex")).toBe(true);
			// Re-install is idempotent.
			expect(installHooks(new Set(["codex"]), "per-turn").results[0]?.reason).toBe("already installed");
		} finally {
			_setHookHomeDirForTest(null);
			_resetBaseDir();
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(memDir, { recursive: true, force: true });
		}
	});

	test("uninstall removes both SessionStart and UserPromptSubmit for Claude", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-mem-"));
		try {
			_setHookHomeDirForTest(home);
			_setBaseDir(memDir);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, JSON.stringify({}));
			installHooks(new Set(["claude"]), "per-turn");
			expect(uninstallHooks(new Set(["claude"])).results[0]?.installed).toBe(true);
			expect(isHookInstalled(home, "claude")).toBe(false);
			expect(isUserPromptSubmitInstalled(home, "claude")).toBe(false);
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			expect(settings).toEqual({});
		} finally {
			_setHookHomeDirForTest(null);
			_resetBaseDir();
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(memDir, { recursive: true, force: true });
		}
	});

	test("re-install deduplicates multiple managed Claude hook groups", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			const settingsPath = path.join(home, ".claude", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			const managedHook = {
				type: "command",
				command: "agent-memory hook session-start --agent claude",
				_agentMemory: true,
			};
			// Simulate 3 duplicate managed groups (as seen in the wild)
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					hooks: {
						SessionStart: [
							{ matcher: "startup|resume", hooks: [managedHook] },
							{ matcher: "startup|resume", hooks: [managedHook] },
							{ matcher: "startup|resume", hooks: [managedHook] },
							{ hooks: [{ type: "command", command: "echo keep" }] },
						],
					},
				}),
			);
			const result = installHooks(new Set(["claude"])).results[0];
			expect(result?.installed).toBe(true);
			expect(result?.reason).toBe("updated");
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			// Only one managed group should remain, plus the unrelated hook
			expect(settings.hooks.SessionStart).toHaveLength(2);
			const managed = settings.hooks.SessionStart.find(
				(g: Record<string, unknown>) =>
					Array.isArray(g.hooks) && (g.hooks as Record<string, unknown>[]).some((h) => h._agentMemory === true),
			);
			expect(managed).toBeDefined();
			expect(managed.matcher).toBeUndefined();
			const unrelated = settings.hooks.SessionStart.find(
				(g: Record<string, unknown>) =>
					Array.isArray(g.hooks) &&
					(g.hooks as Record<string, unknown>[]).some(
						(h) => (h as Record<string, unknown>).command === "echo keep",
					),
			);
			expect(unrelated).toBeDefined();
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("Cursor install writes a real sessionStart hook (hooks.json + script), not just a static rule", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			// Create ~/.cursor so detectHookAgents picks it up.
			fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
			const report = installHooks(new Set(["cursor"]));
			expect(report.results[0]?.installed).toBe(true);

			const hooksJson = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf-8"));
			expect(hooksJson.hooks.sessionStart).toEqual([
				{ command: path.join("hooks", "agent-memory-session-start.js") },
			]);

			const scriptPath = path.join(home, ".cursor", "hooks", "agent-memory-session-start.js");
			expect(fs.existsSync(scriptPath)).toBe(true);
			expect(fs.readFileSync(scriptPath, "utf-8")).toContain("agent-memory context --no-search");
			expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0); // executable bit set

			// Static .mdc rule is still written as a harmless fallback.
			expect(fs.existsSync(path.join(home, ".cursor", "rules", "agent-memory.mdc"))).toBe(true);

			expect(isHookInstalled(home, "cursor")).toBe(true);
			// Re-install is idempotent.
			expect(installHooks(new Set(["cursor"])).results[0]?.reason).toBe("already installed");
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("Cursor uninstall removes our hook entry, script, and rule while preserving unrelated hooks.json entries", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
		try {
			_setHookHomeDirForTest(home);
			fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
			fs.writeFileSync(
				path.join(home, ".cursor", "hooks.json"),
				JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "hooks/keep-me.sh" }] } }),
			);
			installHooks(new Set(["cursor"]));
			expect(isHookInstalled(home, "cursor")).toBe(true);

			expect(uninstallHooks(new Set(["cursor"])).results[0]?.installed).toBe(true);
			expect(isHookInstalled(home, "cursor")).toBe(false);
			expect(fs.existsSync(path.join(home, ".cursor", "hooks", "agent-memory-session-start.js"))).toBe(false);
			expect(fs.existsSync(path.join(home, ".cursor", "rules", "agent-memory.mdc"))).toBe(false);

			const hooksJson = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf-8"));
			expect(hooksJson.hooks.sessionStart).toEqual([{ command: "hooks/keep-me.sh" }]);
		} finally {
			_setHookHomeDirForTest(null);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("CLI prints shell completion without changing the user profile", () => {
		const cli = path.join(__dirname, "..", "src", "cli.ts");
		const result = Bun.spawnSync(["bun", "run", cli, "completion", "zsh", "--stdout"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("#compdef agent-memory");
	});
});

// ---------------------------------------------------------------------------
// 11. npm package portability
// ---------------------------------------------------------------------------

describe("npm package portability", () => {
	test("ships and runs a portable Node.js CLI instead of a native binary", () => {
		const repoRoot = path.join(__dirname, "..");
		const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
			version: string;
			bin: Record<string, string>;
		};
		expect(packageJson.bin["agent-memory"]).toBe("dist/cli.js");

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-npm-package-"));
		try {
			const npm = process.platform === "win32" ? "npm.cmd" : "npm";
			const packResult = Bun.spawnSync([npm, "pack", "--json", "--pack-destination", tempDir], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(packResult.exitCode).toBe(0);

			const [pack] = JSON.parse(packResult.stdout.toString()) as Array<{
				filename: string;
				unpackedSize: number;
				files: Array<{ path: string }>;
			}>;
			const packedPaths = pack.files.map((file) => file.path);
			expect(packedPaths).toContain("dist/cli.js");
			expect(packedPaths).toContain("LICENSE");
			const packedLicense = fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf-8");
			expect(packedLicense).toContain("Copyright (c) 2026 Jay Zeng");
			expect(packedLicense).toContain("Copyright (c) 2026 jo-inc");
			expect(packedPaths).toContain("docs/official-plugin-bootstrap.md");
			expect(packedPaths).not.toContain("dist/agent-memory");
			expect(packedPaths).not.toContain("dist/agent-memory.exe");
			expect(packedPaths).not.toContain("issues.md");
			expect(packedPaths).not.toContain("progress.md");
			expect(
				packedPaths.some((packedPath) =>
					["plugins/", "services/", "artifacts/", "LICENSES/"].some((prefix) => packedPath.startsWith(prefix)),
				),
			).toBe(false);
			expect(packedPaths.some((packedPath) => packedPath.endsWith(".map"))).toBe(false);
			expect(pack.unpackedSize).toBeLessThan(2_000_000);

			const prefix = path.join(tempDir, "prefix");
			const installResult = Bun.spawnSync(
				[npm, "install", "--global", "--prefix", prefix, "--ignore-scripts", path.join(tempDir, pack.filename)],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(installResult.exitCode).toBe(0);

			const executable =
				process.platform === "win32"
					? path.join(prefix, "agent-memory.cmd")
					: path.join(prefix, "bin", "agent-memory");
			const versionResult = Bun.spawnSync([executable, "version"], { stdout: "pipe", stderr: "pipe" });
			expect(versionResult.exitCode).toBe(0);
			expect(versionResult.stdout.toString().trim()).toBe(packageJson.version);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
