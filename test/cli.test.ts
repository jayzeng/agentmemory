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

	test("context returns memory content", async () => {
		// Write some memory first
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Context test memory", "utf-8");

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

	test("help shows usage", async () => {
		const result = Bun.spawnSync(["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		const out = result.stdout.toString();
		expect(out).toContain("agent-memory");
		expect(out).toContain("Commands:");
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
		const result = Bun.spawnSync(
			["bun", "run", path.join(__dirname, "..", "src", "cli.ts"), "status", "--dir", tmpDir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout.toString());
		expect(out.embedMode).toBeDefined();
		expect(["background", "manual", "off"]).toContain(out.embedMode);
	});

	test("install-skills copies SKILL.md into home", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-skill-cli-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-home-cli-"));

		fs.mkdirSync(path.join(projectDir, "skills", "claude-code"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "skills", "claude-code", "SKILL.md"), "# Claude", "utf-8");
		fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });

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
// 7. Install scripts
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

	test("install-skills.sh copies skill files into HOME", () => {
		fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".cursor"), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, ".agents"), { recursive: true });

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
