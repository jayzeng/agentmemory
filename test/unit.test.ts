/**
 * Unit tests for agent-memory.
 *
 * Run:   bun test test/unit.test.ts
 *
 * Uses temp directories for all file I/O — does not touch real memory files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_clearUpdateTimer,
	_getUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	buildMemoryContext,
	dailyPath,
	ensureDirs,
	memoryRead,
	memorySearch,
	memoryWrite,
	nowTimestamp,
	parseScratchpad,
	qmdCollectionInstructions,
	qmdInstallInstructions,
	readFileSafe,
	type ScratchpadItem,
	scheduleQmdUpdate,
	scratchpadAction,
	serializeScratchpad,
	shortSessionId,
	todayStr,
	yesterdayStr,
} from "../src/core.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-test-"));
	_setBaseDir(tmpDir);
}

function cleanupTmpDir() {
	_resetBaseDir();
	_setQmdAvailable(false);
	_clearUpdateTimer();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ==========================================================================
// 1. Utility functions
// ==========================================================================

describe("todayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		const result = todayStr();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns a 10-character string", () => {
		expect(todayStr()).toHaveLength(10);
	});
});

describe("yesterdayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		const result = yesterdayStr();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns a date before today", () => {
		const today = new Date(todayStr());
		const yesterday = new Date(yesterdayStr());
		expect(yesterday.getTime()).toBeLessThan(today.getTime());
	});
});

describe("nowTimestamp", () => {
	test("returns timestamp in YYYY-MM-DD HH:MM:SS format", () => {
		const result = nowTimestamp();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	test("does not contain T or Z", () => {
		const result = nowTimestamp();
		expect(result).not.toContain("T");
		expect(result).not.toContain("Z");
	});
});

describe("shortSessionId", () => {
	test("returns first 8 characters", () => {
		expect(shortSessionId("abcdef1234567890")).toBe("abcdef12");
	});

	test("handles exactly 8 characters", () => {
		expect(shortSessionId("12345678")).toBe("12345678");
	});

	test("handles shorter string", () => {
		expect(shortSessionId("abc")).toBe("abc");
	});

	test("handles empty string", () => {
		expect(shortSessionId("")).toBe("");
	});
});

describe("readFileSafe", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("reads existing file", () => {
		const filePath = path.join(tmpDir, "test.txt");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		expect(readFileSafe(filePath)).toBe("hello world");
	});

	test("returns null for non-existent file", () => {
		expect(readFileSafe(path.join(tmpDir, "nope.txt"))).toBeNull();
	});

	test("reads empty file", () => {
		const filePath = path.join(tmpDir, "empty.txt");
		fs.writeFileSync(filePath, "", "utf-8");
		expect(readFileSafe(filePath)).toBe("");
	});

	test("reads unicode content", () => {
		const filePath = path.join(tmpDir, "unicode.txt");
		fs.writeFileSync(filePath, "Hello 🌍 world", "utf-8");
		expect(readFileSafe(filePath)).toBe("Hello 🌍 world");
	});
});

describe("dailyPath", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns path with .md extension", () => {
		const result = dailyPath("2026-02-15");
		expect(result).toEndWith("2026-02-15.md");
	});

	test("uses daily subdirectory", () => {
		const result = dailyPath("2026-02-15");
		expect(result).toContain(path.join("daily", "2026-02-15.md"));
	});
});

describe("ensureDirs", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("creates memory and daily directories", () => {
		// tmpDir exists but daily subdir doesn't yet
		ensureDirs();
		expect(fs.existsSync(tmpDir)).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "daily"))).toBe(true);
	});

	test("is idempotent", () => {
		ensureDirs();
		ensureDirs(); // should not throw
		expect(fs.existsSync(tmpDir)).toBe(true);
	});
});

// ==========================================================================
// 2. Scratchpad parsing and serialization
// ==========================================================================

describe("parseScratchpad", () => {
	test("parses unchecked items", () => {
		const items = parseScratchpad("- [ ] Fix bug\n- [ ] Add feature\n");
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({ done: false, text: "Fix bug", meta: "" });
		expect(items[1]).toEqual({ done: false, text: "Add feature", meta: "" });
	});

	test("parses checked items", () => {
		const items = parseScratchpad("- [x] Done task\n- [X] Also done\n");
		expect(items).toHaveLength(2);
		expect(items[0].done).toBe(true);
		expect(items[1].done).toBe(true);
	});

	test("parses mixed items", () => {
		const items = parseScratchpad("- [ ] Open\n- [x] Done\n- [ ] Also open\n");
		expect(items).toHaveLength(3);
		expect(items[0].done).toBe(false);
		expect(items[1].done).toBe(true);
		expect(items[2].done).toBe(false);
	});

	test("captures metadata comment from preceding line", () => {
		const content = "<!-- 2026-02-15 10:00:00 [abc12345] -->\n- [ ] Task with meta\n";
		const items = parseScratchpad(content);
		expect(items).toHaveLength(1);
		expect(items[0].meta).toBe("<!-- 2026-02-15 10:00:00 [abc12345] -->");
		expect(items[0].text).toBe("Task with meta");
	});

	test("ignores non-checklist lines", () => {
		const content = "# Scratchpad\n\nSome text\n- [ ] Real item\n- Not a checkbox\n";
		const items = parseScratchpad(content);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Real item");
	});

	test("handles empty content", () => {
		expect(parseScratchpad("")).toHaveLength(0);
	});

	test("handles content with only headers", () => {
		expect(parseScratchpad("# Scratchpad\n\n")).toHaveLength(0);
	});

	test("handles items without metadata", () => {
		const items = parseScratchpad("- [ ] No meta item\n");
		expect(items[0].meta).toBe("");
	});

	test("does not pick up non-comment lines as metadata", () => {
		const content = "some random line\n- [ ] Task\n";
		const items = parseScratchpad(content);
		expect(items[0].meta).toBe("");
	});

	test("handles item at first line (no preceding line for meta)", () => {
		const items = parseScratchpad("- [ ] First line item\n");
		expect(items).toHaveLength(1);
		expect(items[0].meta).toBe("");
	});
});

describe("serializeScratchpad", () => {
	test("serializes unchecked items", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "Fix bug", meta: "" }];
		const result = serializeScratchpad(items);
		expect(result).toBe("# Scratchpad\n\n- [ ] Fix bug\n");
	});

	test("serializes checked items", () => {
		const items: ScratchpadItem[] = [{ done: true, text: "Done task", meta: "" }];
		const result = serializeScratchpad(items);
		expect(result).toBe("# Scratchpad\n\n- [x] Done task\n");
	});

	test("includes metadata comments", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "Task", meta: "<!-- 2026-02-15 [abc] -->" }];
		const result = serializeScratchpad(items);
		expect(result).toContain("<!-- 2026-02-15 [abc] -->");
		expect(result).toContain("- [ ] Task");
	});

	test("serializes empty list", () => {
		const result = serializeScratchpad([]);
		expect(result).toBe("# Scratchpad\n\n");
	});

	test("round-trips correctly", () => {
		const original: ScratchpadItem[] = [
			{ done: false, text: "Open task", meta: "<!-- ts [sid] -->" },
			{ done: true, text: "Done task", meta: "<!-- ts2 [sid2] -->" },
			{ done: false, text: "Another open", meta: "" },
		];
		const serialized = serializeScratchpad(original);
		const parsed = parseScratchpad(serialized);
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toEqual(original[0]);
		expect(parsed[1]).toEqual(original[1]);
		expect(parsed[2]).toEqual(original[2]);
	});
});

// ==========================================================================
// 3. buildMemoryContext
// ==========================================================================

describe("buildMemoryContext", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns empty string when no memory files exist", () => {
		ensureDirs();
		expect(buildMemoryContext()).toBe("");
	});

	test("includes MEMORY.md content", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Important fact", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("## MEMORY.md (long-term)");
		expect(ctx).toContain("Important fact");
	});

	test("includes open scratchpad items only", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [ ] Open item\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("Open item");
		expect(ctx).not.toContain("Done item");
	});

	test("excludes scratchpad section when all items are done", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).not.toContain("SCRATCHPAD");
	});

	test("includes today's daily log", () => {
		ensureDirs();
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`## Daily log: ${today} (today)`);
		expect(ctx).toContain("Today's work");
	});

	test("includes yesterday's daily log", () => {
		ensureDirs();
		const yesterday = yesterdayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`## Daily log: ${yesterday} (yesterday)`);
		expect(ctx).toContain("Yesterday's work");
	});

	test("combines all sections with separators", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Daily content", "utf-8");

		const ctx = buildMemoryContext();
		expect(ctx).toStartWith("# Memory");
		expect(ctx).toContain("---");
		expect(ctx).toContain("Memory content");
		expect(ctx).toContain("Task");
		expect(ctx).toContain("Daily content");
	});

	test("ignores empty/whitespace-only files", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "   \n\n  ", "utf-8");
		expect(buildMemoryContext()).toBe("");
	});
});

// ==========================================================================
// 4. QMD helper functions
// ==========================================================================

describe("qmdInstallInstructions", () => {
	test("includes qmd repo URL", () => {
		expect(qmdInstallInstructions()).toContain("github.com/tobi/qmd");
	});

	test("includes setup commands", () => {
		const instructions = qmdInstallInstructions();
		expect(instructions).toContain("qmd collection add");
		expect(instructions).toContain("qmd embed");
	});
});

describe("qmdCollectionInstructions", () => {
	test("mentions collection not configured", () => {
		expect(qmdCollectionInstructions()).toContain("agent-memory");
	});

	test("includes setup commands", () => {
		const instructions = qmdCollectionInstructions();
		expect(instructions).toContain("qmd collection add");
		expect(instructions).toContain("qmd embed");
	});
});

describe("scheduleQmdUpdate", () => {
	beforeEach(() => {
		_clearUpdateTimer();
	});
	afterEach(() => {
		_clearUpdateTimer();
		_setQmdAvailable(false);
	});

	test("does nothing when qmd is not available", () => {
		_setQmdAvailable(false);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).toBeNull();
	});

	test("sets a timer when qmd is available", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).not.toBeNull();
		_clearUpdateTimer();
	});

	test("debounces multiple calls", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		const firstTimer = _getUpdateTimer();
		scheduleQmdUpdate();
		const secondTimer = _getUpdateTimer();
		// Timer should be replaced (different reference)
		expect(secondTimer).not.toBeNull();
		expect(firstTimer).not.toBe(secondTimer);
		_clearUpdateTimer();
	});
});

// ==========================================================================
// 5. memoryWrite
// ==========================================================================

describe("memoryWrite", () => {
	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
	});

	afterEach(cleanupTmpDir);

	test("appends to empty MEMORY.md", async () => {
		const result = await memoryWrite({
			target: "long_term",
			content: "User likes cats",
			sessionId: "abcdef1234567890",
		});
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("User likes cats");
		expect(content).toContain("<!-- ");
		expect(result.text).toContain("Appended to MEMORY.md");
		expect(result.text).toContain("MEMORY.md was empty");
		expect(result.details.target).toBe("long_term");
		expect(result.details.mode).toBe("append");
	});

	test("appends to existing MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Existing content", "utf-8");
		const result = await memoryWrite({
			target: "long_term",
			content: "New fact",
			sessionId: "abcdef1234567890",
		});
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Existing content");
		expect(content).toContain("New fact");
		expect(result.text).toContain("Existing MEMORY.md preview");
		expect(result.text).toContain("Existing content");
	});

	test("overwrites MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old content", "utf-8");
		const result = await memoryWrite({
			target: "long_term",
			content: "Brand new",
			mode: "overwrite",
			sessionId: "abcdef1234567890",
		});
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Brand new");
		expect(content).not.toContain("Old content");
		expect(content).toContain("<!-- last updated:");
		expect(result.details.mode).toBe("overwrite");
	});

	test("appends to daily log", async () => {
		const result = await memoryWrite({
			target: "daily",
			content: "Did some work",
			sessionId: "abcdef1234567890",
		});
		const today = todayStr();
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		expect(content).toContain("Did some work");
		expect(result.text).toContain("Appended to daily log");
		expect(result.details.target).toBe("daily");
	});

	test("appends to existing daily log", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Morning entry", "utf-8");
		await memoryWrite({
			target: "daily",
			content: "Afternoon entry",
			sessionId: "abcdef1234567890",
		});
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		expect(content).toContain("Morning entry");
		expect(content).toContain("Afternoon entry");
	});

	test("includes session ID in metadata comment", async () => {
		await memoryWrite({
			target: "long_term",
			content: "Test",
			sessionId: "mysession12345678",
		});
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("[mysessio]"); // first 8 chars
	});

	test("includes timestamp in metadata comment", async () => {
		await memoryWrite({
			target: "long_term",
			content: "Test",
		});
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		// Should have a timestamp like "2026-02-15 10:30:00"
		expect(content).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	test("default mode is append", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old", "utf-8");
		const result = await memoryWrite({
			target: "long_term",
			content: "New",
		});
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Old");
		expect(content).toContain("New");
		expect(result.details.mode).toBe("append");
	});
});

// ==========================================================================
// 6. scratchpadAction
// ==========================================================================

describe("scratchpadAction", () => {
	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
	});

	afterEach(cleanupTmpDir);

	test("list on empty scratchpad", async () => {
		const result = await scratchpadAction({ action: "list" });
		expect(result.text).toBe("Scratchpad is empty.");
	});

	test("add item", async () => {
		const result = await scratchpadAction({ action: "add", text: "Fix login bug" });
		expect(result.text).toContain("- [ ] Fix login bug");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("Fix login bug");
		expect(content).toContain("[ ]");
	});

	test("add without text returns error", async () => {
		const result = await scratchpadAction({ action: "add" });
		expect(result.text).toContain("Error");
		expect(result.text).toContain("'text' is required");
	});

	test("done marks item as checked", async () => {
		await scratchpadAction({ action: "add", text: "Fix login bug" });
		const result = await scratchpadAction({ action: "done", text: "login" });
		expect(result.text).toContain("Updated");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("[x]");
	});

	test("done matches by case-insensitive substring", async () => {
		await scratchpadAction({ action: "add", text: "Fix Login Bug" });
		const result = await scratchpadAction({ action: "done", text: "LOGIN" });
		expect(result.text).toContain("Updated");
	});

	test("done without text returns error", async () => {
		const result = await scratchpadAction({ action: "done" });
		expect(result.text).toContain("Error");
	});

	test("done with no matching item", async () => {
		await scratchpadAction({ action: "add", text: "Fix bug" });
		const result = await scratchpadAction({ action: "done", text: "nonexistent" });
		expect(result.text).toContain("No matching");
	});

	test("done on already-done item finds no match", async () => {
		await scratchpadAction({ action: "add", text: "Task" });
		await scratchpadAction({ action: "done", text: "Task" });
		const result = await scratchpadAction({ action: "done", text: "Task" });
		expect(result.text).toContain("No matching open item");
	});

	test("undo unchecks a done item", async () => {
		await scratchpadAction({ action: "add", text: "Task to undo" });
		await scratchpadAction({ action: "done", text: "undo" });
		const result = await scratchpadAction({ action: "undo", text: "undo" });
		expect(result.text).toContain("Updated");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("[ ]");
		expect(content).not.toContain("[x]");
	});

	test("undo without text returns error", async () => {
		const result = await scratchpadAction({ action: "undo" });
		expect(result.text).toContain("Error");
	});

	test("undo on open item finds no match", async () => {
		await scratchpadAction({ action: "add", text: "Open task" });
		const result = await scratchpadAction({ action: "undo", text: "Open task" });
		expect(result.text).toContain("No matching done item");
	});

	test("clear_done removes checked items", async () => {
		await scratchpadAction({ action: "add", text: "Keep this" });
		await scratchpadAction({ action: "add", text: "Remove this" });
		await scratchpadAction({ action: "done", text: "Remove" });
		const result = await scratchpadAction({ action: "clear_done" });
		expect(result.text).toContain("Cleared 1 done item(s)");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("Keep this");
		expect(content).not.toContain("Remove this");
	});

	test("clear_done with no done items", async () => {
		await scratchpadAction({ action: "add", text: "Open" });
		const result = await scratchpadAction({ action: "clear_done" });
		expect(result.text).toContain("Cleared 0 done item(s)");
	});

	test("list shows all items with counts", async () => {
		await scratchpadAction({ action: "add", text: "Open 1" });
		await scratchpadAction({ action: "add", text: "Open 2" });
		await scratchpadAction({ action: "add", text: "Will be done" });
		await scratchpadAction({ action: "done", text: "Will be done" });
		const result = await scratchpadAction({ action: "list" });
		expect(result.details.count).toBe(3);
		expect(result.details.open).toBe(2);
	});

	test("done only matches first matching item", async () => {
		await scratchpadAction({ action: "add", text: "Fix bug A" });
		await scratchpadAction({ action: "add", text: "Fix bug B" });
		await scratchpadAction({ action: "done", text: "Fix bug" });
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		// Only first match should be done
		const items = parseScratchpad(content);
		expect(items[0].done).toBe(true);
		expect(items[1].done).toBe(false);
	});
});

// ==========================================================================
// 7. memoryRead
// ==========================================================================

describe("memoryRead", () => {
	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
	});

	afterEach(cleanupTmpDir);

	// -- long_term --

	test("read long_term when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "My memories", "utf-8");
		const result = await memoryRead({ target: "long_term" });
		expect(result.text).toBe("My memories");
	});

	test("read long_term when file does not exist", async () => {
		const result = await memoryRead({ target: "long_term" });
		expect(result.text).toContain("empty or does not exist");
	});

	test("read long_term when file is empty", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "", "utf-8");
		const result = await memoryRead({ target: "long_term" });
		// readFileSafe returns "" which is falsy, so treated as missing
		expect(result.text).toContain("empty or does not exist");
	});

	// -- scratchpad --

	test("read scratchpad when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const result = await memoryRead({ target: "scratchpad" });
		expect(result.text).toContain("Task");
	});

	test("read scratchpad when empty", async () => {
		const result = await memoryRead({ target: "scratchpad" });
		expect(result.text).toContain("empty or does not exist");
	});

	test("read scratchpad when whitespace only", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "   \n  ", "utf-8");
		const result = await memoryRead({ target: "scratchpad" });
		expect(result.text).toContain("empty or does not exist");
	});

	// -- daily --

	test("read daily defaults to today", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's log", "utf-8");
		const result = await memoryRead({ target: "daily" });
		expect(result.text).toBe("Today's log");
		expect(result.details.date).toBe(today);
	});

	test("read daily with specific date", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-01-01.md"), "New year log", "utf-8");
		const result = await memoryRead({ target: "daily", date: "2026-01-01" });
		expect(result.text).toBe("New year log");
	});

	test("read daily when file does not exist", async () => {
		const result = await memoryRead({ target: "daily", date: "1999-01-01" });
		expect(result.text).toContain("No daily log for 1999-01-01");
	});

	// -- list --

	test("list daily logs when multiple exist", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-14.md"), "b", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-13.md"), "c", "utf-8");
		const result = await memoryRead({ target: "list" });
		expect(result.text).toContain("2026-02-15.md");
		expect(result.text).toContain("2026-02-14.md");
		expect(result.text).toContain("2026-02-13.md");
		expect(result.details.files).toHaveLength(3);
		// Should be reverse sorted (newest first)
		expect((result.details.files as string[])[0]).toBe("2026-02-15.md");
	});

	test("list daily logs when none exist", async () => {
		const result = await memoryRead({ target: "list" });
		expect(result.text).toContain("No daily logs found");
	});

	test("list ignores non-md files", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "notes.txt"), "b", "utf-8");
		const result = await memoryRead({ target: "list" });
		expect(result.details.files).toHaveLength(1);
	});
});

// ==========================================================================
// 8. memorySearch
// ==========================================================================

describe("memorySearch", () => {
	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
	});

	afterEach(cleanupTmpDir);

	test("returns error with setup instructions when qmd not available", async () => {
		const execStub = ((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any;

		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		try {
			const result = await memorySearch({ query: "test" });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("qmd");
		} finally {
			_resetExecFileForTest();
		}
	});
});
