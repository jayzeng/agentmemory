#!/usr/bin/env node
/**
 * agent-memory CLI
 *
 * Subcommands:
 *   context    — Build & print context injection string to stdout
 *   write      — Write to memory files
 *   read       — Read memory files
 *   scratchpad — Manage checklist
 *   search     — Search via qmd
 *   init       — Create dirs, detect qmd, setup collection
 *   status     — Show config, qmd status, file counts
 *
 * Global flags:
 *   --dir <path>   Override memory directory
 *   --json         Machine-readable JSON output
 */

import * as fs from "node:fs";
import {
	_setBaseDir,
	buildMemoryContext,
	checkCollection,
	dailyPath,
	detectQmd,
	ensureDirs,
	ensureQmdAvailableForUpdate,
	getCollectionName,
	getDailyDir,
	getMemoryDir,
	getMemoryFile,
	getQmdResultPath,
	getQmdResultText,
	getScratchpadFile,
	nowTimestamp,
	parseScratchpad,
	readFileSafe,
	runQmdSearch,
	scheduleQmdUpdate,
	searchRelevantMemories,
	serializeScratchpad,
	setupQmdCollection,
	todayStr,
} from "./core.js";

// ---------------------------------------------------------------------------
// Arg parsing (no external deps)
// ---------------------------------------------------------------------------

interface ParsedArgs {
	command: string;
	flags: Record<string, string | boolean>;
	positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	let command = "";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (!command && !arg.startsWith("-")) {
			command = arg;
			continue;
		}

		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	return { command, flags, positional };
}

function getFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
	const val = flags[key];
	return typeof val === "string" ? val : undefined;
}

function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
	return key in flags;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean) {
	if (json) {
		console.log(JSON.stringify(data, null, 2));
	} else if (typeof data === "string") {
		console.log(data);
	} else {
		console.log(JSON.stringify(data, null, 2));
	}
}

function exitError(message: string, json: boolean): never {
	if (json) {
		console.error(JSON.stringify({ error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdContext(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const noSearch = hasFlag(flags, "no-search");

	ensureDirs();
	const searchResults = noSearch ? "" : await searchRelevantMemories("");
	const context = buildMemoryContext(searchResults);

	if (json) {
		output({ context, directory: getMemoryDir() }, true);
	} else {
		if (context) {
			process.stdout.write(context);
		}
	}
}

async function cmdWrite(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const target = getFlag(flags, "target");
	const content = getFlag(flags, "content");
	const mode = getFlag(flags, "mode") ?? "append";

	if (!target || !["long_term", "daily"].includes(target)) {
		exitError("--target must be 'long_term' or 'daily'", json);
	}
	if (!content) {
		exitError("--content is required", json);
	}

	ensureDirs();
	const ts = nowTimestamp();
	const sid = "cli";

	if (target === "daily") {
		const filePath = dailyPath(todayStr());
		const existing = readFileSafe(filePath) ?? "";
		const separator = existing.trim() ? "\n\n" : "";
		const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
		fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(
			json
				? { ok: true, path: filePath, target, mode: "append", timestamp: ts }
				: `Appended to daily log: ${filePath}`,
			json,
		);
		return;
	}

	// long_term
	const memFile = getMemoryFile();
	const existing = readFileSafe(memFile) ?? "";

	if (mode === "overwrite") {
		const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
		fs.writeFileSync(memFile, stamped, "utf-8");
	} else {
		const separator = existing.trim() ? "\n\n" : "";
		const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
		fs.writeFileSync(memFile, existing + separator + stamped, "utf-8");
	}
	await ensureQmdAvailableForUpdate();
	scheduleQmdUpdate();
	output(
		json
			? { ok: true, path: memFile, target, mode, timestamp: ts }
			: `${mode === "overwrite" ? "Overwrote" : "Appended to"} MEMORY.md`,
		json,
	);
}

async function cmdRead(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const target = getFlag(flags, "target");
	const date = getFlag(flags, "date");

	if (!target || !["long_term", "scratchpad", "daily", "list"].includes(target)) {
		exitError("--target must be 'long_term', 'scratchpad', 'daily', or 'list'", json);
	}

	ensureDirs();

	if (target === "list") {
		try {
			const files = fs
				.readdirSync(getDailyDir())
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (json) {
				output({ files }, true);
			} else if (files.length === 0) {
				console.log("No daily logs found.");
			} else {
				console.log(`Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`);
			}
		} catch {
			output(json ? { files: [] } : "No daily logs directory.", json);
		}
		return;
	}

	if (target === "daily") {
		const d = date ?? todayStr();
		const filePath = dailyPath(d);
		const content = readFileSafe(filePath);
		if (!content) {
			output(json ? { content: null, date: d } : `No daily log for ${d}.`, json);
			return;
		}
		output(json ? { content, date: d, path: filePath } : content, json);
		return;
	}

	if (target === "scratchpad") {
		const content = readFileSafe(getScratchpadFile());
		if (!content?.trim()) {
			output(
				json
					? { content: null }
					: "SCRATCHPAD.md is empty or does not exist.",
				json,
			);
			return;
		}
		output(json ? { content, path: getScratchpadFile() } : content, json);
		return;
	}

	// long_term
	const content = readFileSafe(getMemoryFile());
	if (!content) {
		output(
			json ? { content: null } : "MEMORY.md is empty or does not exist.",
			json,
		);
		return;
	}
	output(json ? { content, path: getMemoryFile() } : content, json);
}

async function cmdScratchpad(
	flags: Record<string, string | boolean>,
	positional: string[],
) {
	const json = hasFlag(flags, "json");
	const action = positional[0];
	const text = getFlag(flags, "text");

	if (!action || !["add", "done", "undo", "clear_done", "list"].includes(action)) {
		exitError(
			"Usage: agent-memory scratchpad <add|done|undo|clear_done|list> [--text <text>]",
			json,
		);
	}

	ensureDirs();
	const spFile = getScratchpadFile();
	const existing = readFileSafe(spFile) ?? "";
	let items = parseScratchpad(existing);

	if (action === "list") {
		if (items.length === 0) {
			output(json ? { items: [], count: 0, open: 0 } : "Scratchpad is empty.", json);
			return;
		}
		if (json) {
			output({
				items: items.map((i) => ({ done: i.done, text: i.text })),
				count: items.length,
				open: items.filter((i) => !i.done).length,
			}, true);
		} else {
			console.log(serializeScratchpad(items));
		}
		return;
	}

	if (action === "add") {
		if (!text) exitError("--text is required for add", json);
		const ts = nowTimestamp();
		items.push({ done: false, text: text!, meta: `<!-- ${ts} [cli] -->` });
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(json ? { ok: true, action, text } : `Added: - [ ] ${text}`, json);
		return;
	}

	if (action === "done" || action === "undo") {
		if (!text) exitError(`--text is required for ${action}`, json);
		const needle = text!.toLowerCase();
		const targetDone = action === "done";
		let matched = false;
		for (const item of items) {
			if (item.done !== targetDone && item.text.toLowerCase().includes(needle)) {
				item.done = targetDone;
				matched = true;
				break;
			}
		}
		if (!matched) {
			exitError(
				`No matching ${targetDone ? "open" : "done"} item found for: "${text}"`,
				json,
			);
		}
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(json ? { ok: true, action, text } : "Updated.", json);
		return;
	}

	if (action === "clear_done") {
		const before = items.length;
		items = items.filter((i) => !i.done);
		const removed = before - items.length;
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(
			json ? { ok: true, action, removed } : `Cleared ${removed} done item(s).`,
			json,
		);
	}
}

async function cmdSearch(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const query = getFlag(flags, "query");
	const mode = (getFlag(flags, "mode") ?? "keyword") as "keyword" | "semantic" | "deep";
	const limit = Number.parseInt(getFlag(flags, "limit") ?? "5", 10);

	if (!query) exitError("--query is required", json);
	if (!["keyword", "semantic", "deep"].includes(mode)) {
		exitError("--mode must be 'keyword', 'semantic', or 'deep'", json);
	}

	const qmdFound = await detectQmd();
	if (!qmdFound) {
		exitError("qmd is not installed. Install: bun install -g https://github.com/tobi/qmd", json);
	}

	const collName = getCollectionName();
	const hasCollection = await checkCollection(collName);
	if (!hasCollection) {
		exitError(
			`qmd collection '${collName}' not found. Run: agent-memory init`,
			json,
		);
	}

	try {
		const { results, stderr } = await runQmdSearch(mode, query!, limit);

		if (json) {
			output({ mode, query, count: results.length, results }, true);
			return;
		}

		if (results.length === 0) {
			const needsEmbed = /need embeddings/i.test(stderr ?? "");
			if (needsEmbed && (mode === "semantic" || mode === "deep")) {
				console.log(
					`No results found. qmd reports missing embeddings — run: qmd embed`,
				);
			} else {
				console.log(`No results found for "${query}" (mode: ${mode}).`);
			}
			return;
		}

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const filePath = getQmdResultPath(r);
			const text = getQmdResultText(r);
			console.log(`--- Result ${i + 1} ---`);
			if (filePath) console.log(`File: ${filePath}`);
			if (r.score != null) console.log(`Score: ${r.score}`);
			if (text) console.log(text);
			console.log("");
		}
	} catch (err) {
		exitError(
			`Search failed: ${err instanceof Error ? err.message : String(err)}`,
			json,
		);
	}
}

async function cmdInit(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();
	const dir = getMemoryDir();

	const qmdFound = await detectQmd();
	let collectionCreated = false;

	if (qmdFound) {
		const collName = getCollectionName();
		const hasCollection = await checkCollection(collName);
		if (!hasCollection) {
			collectionCreated = await setupQmdCollection();
		}
	}

	if (json) {
		output({
			ok: true,
			directory: dir,
			qmd: qmdFound,
			collectionCreated,
		}, true);
	} else {
		console.log(`Memory directory: ${dir}`);
		console.log(`  MEMORY.md, SCRATCHPAD.md, daily/ created.`);
		if (qmdFound) {
			if (collectionCreated) {
				console.log(`  qmd collection '${getCollectionName()}' created.`);
			} else {
				console.log(`  qmd collection '${getCollectionName()}' already exists.`);
			}
		} else {
			console.log(`  qmd not found — search features unavailable.`);
			console.log(`  Install: bun install -g https://github.com/tobi/qmd`);
		}
	}
}

async function cmdStatus(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();
	const dir = getMemoryDir();
	const memFile = getMemoryFile();
	const spFile = getScratchpadFile();
	const dailyDir = getDailyDir();

	const memContent = readFileSafe(memFile);
	const spContent = readFileSafe(spFile);

	let dailyCount = 0;
	try {
		dailyCount = fs
			.readdirSync(dailyDir)
			.filter((f) => f.endsWith(".md")).length;
	} catch {
		// directory may not exist
	}

	const qmdFound = await detectQmd();
	let hasCollection = false;
	if (qmdFound) {
		hasCollection = await checkCollection();
	}

	if (json) {
		output({
			directory: dir,
			memoryFile: {
				exists: memContent !== null,
				chars: memContent?.length ?? 0,
				lines: memContent ? memContent.split("\n").length : 0,
			},
			scratchpadFile: {
				exists: spContent !== null,
				items: spContent ? parseScratchpad(spContent).length : 0,
				openItems: spContent
					? parseScratchpad(spContent).filter((i) => !i.done).length
					: 0,
			},
			dailyLogs: dailyCount,
			qmd: {
				available: qmdFound,
				collection: hasCollection ? getCollectionName() : null,
			},
		}, true);
	} else {
		console.log(`Memory directory: ${dir}`);
		console.log("");
		if (memContent !== null) {
			const lines = memContent.split("\n").length;
			console.log(`MEMORY.md: ${memContent.length} chars, ${lines} lines`);
		} else {
			console.log("MEMORY.md: not created yet");
		}
		if (spContent !== null) {
			const items = parseScratchpad(spContent);
			const open = items.filter((i) => !i.done).length;
			console.log(`SCRATCHPAD.md: ${items.length} items (${open} open)`);
		} else {
			console.log("SCRATCHPAD.md: not created yet");
		}
		console.log(`Daily logs: ${dailyCount} file(s)`);
		console.log("");
		if (qmdFound) {
			console.log(`qmd: available`);
			console.log(
				`Collection '${getCollectionName()}': ${hasCollection ? "configured" : "not configured — run: agent-memory init"}`,
			);
		} else {
			console.log("qmd: not installed");
		}
	}
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
	console.log(`agent-memory — persistent memory for coding agents

Usage:
  agent-memory <command> [options]

Commands:
  context     Build & print context injection string
  write       Write to memory files
  read        Read memory files
  scratchpad  Manage checklist items
  search      Search across memory files (requires qmd)
  init        Initialize memory directory and qmd collection
  status      Show configuration and status

Global flags:
  --dir <path>   Override memory directory
  --json         Machine-readable JSON output

Examples:
  agent-memory init
  agent-memory write --target long_term --content "User prefers dark mode"
  agent-memory write --target daily --content "Fixed auth bug in login flow"
  agent-memory read --target long_term
  agent-memory read --target daily --date 2026-02-15
  agent-memory read --target list
  agent-memory scratchpad add --text "Review PR #42"
  agent-memory scratchpad list
  agent-memory scratchpad done --text "PR #42"
  agent-memory search --query "database choice" --mode keyword
  agent-memory context --no-search
  agent-memory status --json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const { command, flags, positional } = parseArgs(process.argv.slice(2));
	const json = hasFlag(flags, "json");

	// Apply --dir override
	const dir = getFlag(flags, "dir");
	if (dir) {
		_setBaseDir(dir);
	}

	if (!command || command === "help" || hasFlag(flags, "help")) {
		printUsage();
		return;
	}

	switch (command) {
		case "context":
			await cmdContext(flags);
			break;
		case "write":
			await cmdWrite(flags);
			break;
		case "read":
			await cmdRead(flags);
			break;
		case "scratchpad":
			await cmdScratchpad(flags, positional);
			break;
		case "search":
			await cmdSearch(flags);
			break;
		case "init":
			await cmdInit(flags);
			break;
		case "status":
			await cmdStatus(flags);
			break;
		default:
			exitError(`Unknown command: ${command}. Run 'agent-memory help' for usage.`, json);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
