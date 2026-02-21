/**
 * Shared core logic for agent-memory.
 *
 * Core logic for agent-memory CLI and skills.
 * Zero pi peer dependencies — only node:fs, node:path, node:child_process.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_DIR =
	process.env.AGENT_MEMORY_DIR ?? path.join(process.env.HOME ?? "~", ".agent-memory");

let MEMORY_DIR = DEFAULT_MEMORY_DIR;
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");

/** Override base directory (for testing or platform-specific defaults). */
export function _setBaseDir(baseDir: string) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
}

/** Reset to default paths. */
export function _resetBaseDir() {
	_setBaseDir(DEFAULT_MEMORY_DIR);
}

/** Get the current memory directory path. */
export function getMemoryDir(): string {
	return MEMORY_DIR;
}

/** Get the current MEMORY.md path. */
export function getMemoryFile(): string {
	return MEMORY_FILE;
}

/** Get the current SCRATCHPAD.md path. */
export function getScratchpadFile(): string {
	return SCRATCHPAD_FILE;
}

/** Get the current daily log directory path. */
export function getDailyDir(): string {
	return DAILY_DIR;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
}

export function todayStr(): string {
	const d = new Date();
	return d.toISOString().slice(0, 10);
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

export function nowTimestamp(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

export function dailyPath(date: string): string {
	return path.join(DAILY_DIR, `${date}.md`);
}

// ---------------------------------------------------------------------------
// Limits + preview helpers
// ---------------------------------------------------------------------------

export const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
export const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
const CONTEXT_MAX_CHARS = 16_000;

export type TruncateMode = "start" | "end" | "middle";

export interface PreviewResult {
	preview: string;
	truncated: boolean;
	totalLines: number;
	totalChars: number;
	previewLines: number;
	previewChars: number;
}

function normalizeContent(content: string): string {
	return content.trim();
}

export function truncateLines(lines: string[], maxLines: number, mode: TruncateMode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}

	if (mode === "end") {
		return { lines: lines.slice(-maxLines), truncated: true };
	}

	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		const head = lines.slice(0, headCount);
		const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
		return { lines: [...head, marker, ...tail], truncated: true };
	}

	return { lines: lines.slice(0, maxLines), truncated: true };
}

export function truncateText(text: string, maxChars: number, mode: TruncateMode) {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}

	if (mode === "end") {
		return { text: text.slice(-maxChars), truncated: true };
	}

	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}

	return { text: text.slice(0, maxChars), truncated: true };
}

export function buildPreview(
	content: string,
	options: { maxLines: number; maxChars: number; mode: TruncateMode },
): PreviewResult {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return {
			preview: "",
			truncated: false,
			totalLines: 0,
			totalChars: 0,
			previewLines: 0,
			previewChars: 0,
		};
	}

	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;

	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	const text = lineResult.lines.join("\n");
	const charResult = truncateText(text, options.maxChars, options.mode);
	const preview = charResult.text;

	const previewLines = preview ? preview.split("\n").length : 0;
	const previewChars = preview.length;

	return {
		preview,
		truncated: lineResult.truncated || charResult.truncated,
		totalLines,
		totalChars,
		previewLines,
		previewChars,
	};
}

export function formatPreviewBlock(label: string, content: string, mode: TruncateMode) {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});

	if (!result.preview) {
		return `${label}: empty.`;
	}

	const meta = `${label} (${result.totalLines} lines, ${result.totalChars} chars)`;
	const note = result.truncated
		? `\n[preview truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${meta}\n\n${result.preview}${note}`;
}

export function formatContextSection(
	label: string,
	content: string,
	mode: TruncateMode,
	maxLines: number,
	maxChars: number,
) {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) {
		return "";
	}
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string; // the <!-- timestamp [session] --> comment
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(searchResults?: string): string {
	ensureDirs();
	// Priority order: scratchpad > today's daily > search results > MEMORY.md > yesterday's daily
	const sections: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;
let execFileFn: ExecFileFn = execFile;

let qmdAvailable = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;

/** QMD collection name — configurable per platform. */
let QMD_COLLECTION_NAME = "agent-memory";

/** Override execFile implementation (for testing). */
export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}

/** Reset execFile implementation (for testing). */
export function _resetExecFileForTest() {
	execFileFn = execFile;
}

/** Set qmd availability flag (for testing). */
export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
}

/** Get current qmd availability flag. */
export function _getQmdAvailable(): boolean {
	return qmdAvailable;
}

/** Get current update timer (for testing). */
export function _getUpdateTimer(): ReturnType<typeof setTimeout> | null {
	return updateTimer;
}

/** Clear the update timer (for testing). */
export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

/** Get the current QMD collection name. */
export function getCollectionName(): string {
	return QMD_COLLECTION_NAME;
}

/** Set the QMD collection name (for platform-specific overrides). */
export function setCollectionName(name: string) {
	QMD_COLLECTION_NAME = name;
}

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (requires Bun):",
		`  bun install -g ${QMD_REPO_URL}`,
		"  # ensure ~/.bun/bin is in your PATH",
		"",
		"Then set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name ${QMD_COLLECTION_NAME}`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		`qmd collection ${QMD_COLLECTION_NAME} is not configured.`,
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name ${QMD_COLLECTION_NAME}`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the qmd collection and path contexts. */
export async function setupQmdCollection(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn(
				"qmd",
				["collection", "add", MEMORY_DIR, "--name", QMD_COLLECTION_NAME],
				{ timeout: 10_000 },
				(err) => (err ? reject(err) : resolve()),
			);
		});
	} catch {
		// Collection may already exist under a different name — not critical
		return false;
	}

	// Add path contexts (best-effort, ignore errors)
	const contexts: [string, string][] = [
		["/daily", "Daily append-only work logs organized by date"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn(
					"qmd",
					["context", "add", ctxPath, desc, "-c", QMD_COLLECTION_NAME],
					{ timeout: 10_000 },
					(err) => (err ? reject(err) : resolve()),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	return true;
}

export function detectQmd(): Promise<boolean> {
	return new Promise((resolve) => {
		// qmd doesn't reliably support --version; use a fast command that exits 0 when available.
		execFileFn("qmd", ["status"], { timeout: 5_000 }, (err) => {
			resolve(!err);
		});
	});
}

export function checkCollection(name?: string): Promise<boolean> {
	const collName = name ?? QMD_COLLECTION_NAME;
	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			if (err) {
				resolve(false);
				return;
			}
			try {
				const collections = JSON.parse(stdout);
				if (Array.isArray(collections)) {
					resolve(
						collections.some((entry) => {
							if (typeof entry === "string") return entry === collName;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === collName;
							}
							return false;
						}),
					);
				} else {
					// qmd may output an object with a collections array or similar
					resolve(stdout.includes(collName));
				}
			} catch {
				// Fallback: just check if the name appears in the output
				resolve(stdout.includes(collName));
			}
		});
	});
}

export function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.AGENT_MEMORY_QMD_UPDATE ?? process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => {});
	}, 500);
}

export async function runQmdUpdateNow() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	await new Promise<void>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	try {
		const hasCollection = await checkCollection();
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	}
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	title?: string;
	[key: string]: unknown;
}

export function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

export function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text: string): string {
	// qmd may emit spinners/progress bars even with --json, especially on first model download.
	// Strip ANSI CSI/OSC sequences so we can reliably find and parse JSON payloads.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", QMD_COLLECTION_NAME, "-n", String(limit), query];

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: 60_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr?.trim() || err.message));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed)
					? parsed
					: ((parsed as any).results ?? (parsed as any).hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Standalone tool functions
// ---------------------------------------------------------------------------

export interface ToolResult {
	text: string;
	details: Record<string, unknown>;
	isError?: boolean;
}

export async function memoryWrite(params: {
	target: "long_term" | "daily";
	content: string;
	mode?: "append" | "overwrite";
	sessionId?: string;
}): Promise<ToolResult> {
	ensureDirs();
	const { target, content, mode } = params;
	const sid = shortSessionId(params.sessionId ?? "cli");
	const ts = nowTimestamp();

	if (target === "daily") {
		const filePath = dailyPath(todayStr());
		const existing = readFileSafe(filePath) ?? "";
		const existingPreview = buildPreview(existing, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "end",
		});
		const existingSnippet = existingPreview.preview
			? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
			: "\n\nDaily log was empty.";

		const separator = existing.trim() ? "\n\n" : "";
		const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
		fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		return {
			text: `Appended to daily log: ${filePath}${existingSnippet}`,
			details: {
				path: filePath,
				target,
				mode: "append",
				sessionId: sid,
				timestamp: ts,
				qmdUpdateMode: getQmdUpdateMode(),
				existingPreview,
			},
		};
	}

	// long_term
	const memFile = getMemoryFile();
	const existing = readFileSafe(memFile) ?? "";
	const existingPreview = buildPreview(existing, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode: "middle",
	});
	const existingSnippet = existingPreview.preview
		? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
		: "\n\nMEMORY.md was empty.";

	if (mode === "overwrite") {
		const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
		fs.writeFileSync(memFile, stamped, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		return {
			text: `Overwrote MEMORY.md${existingSnippet}`,
			details: {
				path: memFile,
				target,
				mode: "overwrite",
				sessionId: sid,
				timestamp: ts,
				qmdUpdateMode: getQmdUpdateMode(),
				existingPreview,
			},
		};
	}

	// append (default)
	const separator = existing.trim() ? "\n\n" : "";
	const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
	fs.writeFileSync(memFile, existing + separator + stamped, "utf-8");
	await ensureQmdAvailableForUpdate();
	scheduleQmdUpdate();
	return {
		text: `Appended to MEMORY.md${existingSnippet}`,
		details: {
			path: memFile,
			target,
			mode: "append",
			sessionId: sid,
			timestamp: ts,
			qmdUpdateMode: getQmdUpdateMode(),
			existingPreview,
		},
	};
}

export async function scratchpadAction(params: {
	action: "add" | "done" | "undo" | "clear_done" | "list";
	text?: string;
	sessionId?: string;
}): Promise<ToolResult> {
	ensureDirs();
	const { action, text } = params;
	const sid = shortSessionId(params.sessionId ?? "cli");
	const ts = nowTimestamp();
	const spFile = getScratchpadFile();

	const existing = readFileSafe(spFile) ?? "";
	let items = parseScratchpad(existing);

	if (action === "list") {
		if (items.length === 0) {
			return { text: "Scratchpad is empty.", details: {} };
		}
		const serialized = serializeScratchpad(items);
		const preview = buildPreview(serialized, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "start",
		});
		return {
			text: formatPreviewBlock("Scratchpad preview", serialized, "start"),
			details: {
				count: items.length,
				open: items.filter((i) => !i.done).length,
				preview,
			},
		};
	}

	if (action === "add") {
		if (!text) {
			return { text: "Error: 'text' is required for add.", details: {} };
		}
		items.push({ done: false, text, meta: `<!-- ${ts} [${sid}] -->` });
		const serialized = serializeScratchpad(items);
		const preview = buildPreview(serialized, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "start",
		});
		fs.writeFileSync(spFile, serialized, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		return {
			text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
			details: {
				action,
				sessionId: sid,
				timestamp: ts,
				qmdUpdateMode: getQmdUpdateMode(),
				preview,
			},
		};
	}

	if (action === "done" || action === "undo") {
		if (!text) {
			return { text: `Error: 'text' is required for ${action}.`, details: {} };
		}
		const needle = text.toLowerCase();
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
			return {
				text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"`,
				details: {},
			};
		}
		const serialized = serializeScratchpad(items);
		const preview = buildPreview(serialized, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "start",
		});
		fs.writeFileSync(spFile, serialized, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		return {
			text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
			details: {
				action,
				sessionId: sid,
				timestamp: ts,
				qmdUpdateMode: getQmdUpdateMode(),
				preview,
			},
		};
	}

	if (action === "clear_done") {
		const before = items.length;
		items = items.filter((i) => !i.done);
		const removed = before - items.length;
		const serialized = serializeScratchpad(items);
		const preview = buildPreview(serialized, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "start",
		});
		fs.writeFileSync(spFile, serialized, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		return {
			text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
			details: {
				action,
				removed,
				qmdUpdateMode: getQmdUpdateMode(),
				preview,
			},
		};
	}

	return { text: `Unknown action: ${action}`, details: {} };
}

export async function memoryRead(params: {
	target: "long_term" | "scratchpad" | "daily" | "list";
	date?: string;
}): Promise<ToolResult> {
	ensureDirs();
	const { target, date } = params;

	if (target === "list") {
		try {
			const files = fs
				.readdirSync(getDailyDir())
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (files.length === 0) {
				return { text: "No daily logs found.", details: {} };
			}
			return {
				text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`,
				details: { files },
			};
		} catch {
			return { text: "No daily logs directory.", details: {} };
		}
	}

	if (target === "daily") {
		const d = date ?? todayStr();
		const filePath = dailyPath(d);
		const content = readFileSafe(filePath);
		if (!content) {
			return { text: `No daily log for ${d}.`, details: {} };
		}
		return { text: content, details: { path: filePath, date: d } };
	}

	if (target === "scratchpad") {
		const content = readFileSafe(getScratchpadFile());
		if (!content?.trim()) {
			return {
				text: "SCRATCHPAD.md is empty or does not exist.",
				details: {},
			};
		}
		return { text: content, details: { path: getScratchpadFile() } };
	}

	// long_term
	const content = readFileSafe(getMemoryFile());
	if (!content) {
		return {
			text: "MEMORY.md is empty or does not exist.",
			details: {},
		};
	}
	return { text: content, details: { path: getMemoryFile() } };
}

export async function memorySearch(params: {
	query: string;
	mode?: "keyword" | "semantic" | "deep";
	limit?: number;
}): Promise<ToolResult> {
	let isAvailable = qmdAvailable;
	if (!isAvailable) {
		const found = await detectQmd();
		_setQmdAvailable(found);
		isAvailable = found;
	}

	if (!isAvailable) {
		return {
			text: qmdInstallInstructions(),
			details: {},
			isError: true,
		};
	}

	const collName = QMD_COLLECTION_NAME;
	let hasCollection = await checkCollection(collName);
	if (!hasCollection) {
		const created = await setupQmdCollection();
		if (created) {
			hasCollection = true;
		}
	}
	if (!hasCollection) {
		return {
			text: `Could not set up qmd ${collName} collection. Check that qmd is working and the memory directory exists.`,
			details: {},
			isError: true,
		};
	}

	const mode = params.mode ?? "keyword";
	const limit = params.limit ?? 5;

	try {
		const { results, stderr } = await runQmdSearch(mode, params.query, limit);
		const needsEmbed = /need embeddings/i.test(stderr ?? "");

		if (results.length === 0) {
			if (needsEmbed && (mode === "semantic" || mode === "deep")) {
				return {
					text: [
						`No results found for "${params.query}" (mode: ${mode}).`,
						"",
						"qmd reports missing vector embeddings for one or more documents.",
						"Run this once, then retry:",
						"  qmd embed",
					].join("\n"),
					details: {
						mode,
						query: params.query,
						count: 0,
						needsEmbed: true,
					},
				};
			}
			return {
				text: `No results found for "${params.query}" (mode: ${mode}).`,
				details: { mode, query: params.query, count: 0, needsEmbed },
			};
		}

		const formatted = results
			.map((r, i) => {
				const parts: string[] = [`### Result ${i + 1}`];
				const filePath = getQmdResultPath(r);
				if (filePath) parts.push(`**File:** ${filePath}`);
				if (r.score != null) parts.push(`**Score:** ${r.score}`);
				const text = getQmdResultText(r);
				if (text) parts.push(`\n${text}`);
				return parts.join("\n");
			})
			.join("\n\n---\n\n");

		return {
			text: formatted,
			details: {
				mode,
				query: params.query,
				count: results.length,
				needsEmbed,
			},
		};
	} catch (err) {
		return {
			text: `memory_search error: ${err instanceof Error ? err.message : String(err)}`,
			details: {},
			isError: true,
		};
	}
}
