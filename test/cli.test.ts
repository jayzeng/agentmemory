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
import { _setHookHomeDirForTest, installHooks, uninstallHooks } from "../src/hooks.js";

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

	test("init creates directories", async () => {
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "init", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(true);
		expect(out.directory).toBe(tmpDir);
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
		expect(out).toContain("Commands:");
		expect(out).toContain("plugin");
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
		expect(stdout).toContain("AgentMemory Pro includes:");
		expect(stdout).toContain("Session Intelligence");
		expect(stdout).toContain("Guided Learning");
		expect(stdout).toContain("Local Web Console");
		expect(stdout).toContain("Your session content stays on this device.");
		expect(stdout).toContain("agent-memory plugin install");
	});

	test("non-interactive plugin install requires temporary email activation without touching disk", () => {
		const pluginDir = path.join(tmpDir, "plugin-install");
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin", "install", "--json"],
			{
				env: { ...process.env, AGENT_MEMORY_PLUGIN_DIR: pluginDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(1);
		const out = JSON.parse(result.stdout.toString());
		expect(out.ok).toBe(false);
		expect(out.result).toBe("auth_required");
		expect(out.error.code).toBe("auth_required");
		expect(out.nextAction.url).toBe("https://jayzeng.github.io/agentmemory/");
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

	test("plugin help documents temporary activation", () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "plugin", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const out = result.stdout.toString();
		expect(out).toContain("agent-memory plugin install");
		expect(out).toContain("temporary email activation");
	});

	test("unknown command exits with error", async () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "invalid", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
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
		expect(packageJson.bin["agent-memory"]).toBe("./dist/cli.js");

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
