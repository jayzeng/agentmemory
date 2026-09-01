/**
 * Shared core logic for agent-memory.
 *
 * Core logic for agent-memory CLI and skills.
 * Zero pi peer dependencies — only node:fs, node:path, node:child_process.
 */

import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_DIR = process.env.AGENT_MEMORY_DIR ?? path.join(process.env.HOME ?? "~", ".agent-memory");

let MEMORY_DIR = DEFAULT_MEMORY_DIR;
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let TOPICS_DIR = path.join(MEMORY_DIR, "topics");

/** Override base directory (for testing or platform-specific defaults). */
export function _setBaseDir(baseDir: string) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
	TOPICS_DIR = path.join(baseDir, "topics");
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

/** Get the current topics directory path. */
export function getTopicsDir(): string {
	return TOPICS_DIR;
}

// ---------------------------------------------------------------------------
// Hook mode config (per-turn vs stable)
// ---------------------------------------------------------------------------

export type HookMode = "stable" | "per-turn";

const HOOK_CONFIG_FILENAME = "hook-config.json";
const HOOK_MODE_DEFAULT: HookMode = "per-turn";

function hookConfigPath(): string {
	return path.join(MEMORY_DIR, HOOK_CONFIG_FILENAME);
}

/**
 * Resolve the active hook mode.
 * Precedence: `AGENT_MEMORY_HOOK_MODE` env var → `<memoryDir>/hook-config.json`
 * → default `per-turn`. Invalid values fall through to the next source.
 */
export function readHookMode(): HookMode {
	const env = process.env.AGENT_MEMORY_HOOK_MODE;
	if (env === "stable" || env === "per-turn") return env;
	try {
		const raw = fs.readFileSync(hookConfigPath(), "utf-8");
		const parsed = JSON.parse(raw) as { mode?: unknown };
		if (parsed.mode === "stable" || parsed.mode === "per-turn") return parsed.mode;
	} catch {}
	return HOOK_MODE_DEFAULT;
}

/**
 * Atomically persist the chosen hook mode. Called by `install-hooks` after a
 * successful install pass so `doctor` and later invocations can report it.
 */
export function writeHookMode(mode: HookMode): void {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	const target = hookConfigPath();
	const temporary = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify({ mode }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, target);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(TOPICS_DIR, { recursive: true });
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

export function topicPath(slug: string): string {
	return path.join(TOPICS_DIR, `${slug}.md`);
}

export function slugifyTopic(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/--+/g, "-");
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
const CONTEXT_TOPICS_MAX_CHARS = 2_000;
const CONTEXT_TOPICS_MAX_LINES = 100;
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

const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}["']?/gi,
];

/** Redact common credential shapes before content reaches disk or agent context. */
export function redactSecrets(content: string): { content: string; redacted: boolean } {
	let redactedContent = content;
	for (const pattern of SECRET_PATTERNS) {
		redactedContent = redactedContent.replace(pattern, "[REDACTED_SECRET]");
	}
	return { content: redactedContent, redacted: redactedContent !== content };
}

function isInactiveMemoryEntry(entry: string, now: Date): boolean {
	const metadataHeader = entry.split(/\n\s*\n/, 1)[0];
	if (/^\s*(?:[-*]\s*)?Trust:\s*untrusted\s*\.?\s*$/im.test(metadataHeader)) return true;
	if (/^\s*(?:[-*]\s*)?Status:\s*(?:expired|superseded|revoked|retired)\s*\.?\s*$/im.test(metadataHeader)) {
		return true;
	}

	const validUntil = metadataHeader.match(/^\s*(?:[-*]\s*)?Valid until:?\s+(\d{4}-\d{2}-\d{2})\s*\.?\s*$/im)?.[1];
	if (validUntil && validUntil < now.toISOString().slice(0, 10)) return true;
	return false;
}

function splitLogicalMemoryEntries(content: string): { entries: string[]; timestampDelimited: boolean } {
	const normalized = content.replace(/^\uFEFF/, "");
	const marker = /^<!--\s*(?:last updated:\s*)?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]]+\]\s*-->$/gm;
	const starts = [...normalized.matchAll(marker)].map((match) => match.index ?? 0);
	if (starts.length === 0) {
		return { entries: normalized.split(/\n\s*\n/), timestampDelimited: false };
	}

	const entries: string[] = [];
	const preamble = normalized.slice(0, starts[0]).trim();
	if (preamble) entries.push(preamble);
	for (let i = 0; i < starts.length; i++) {
		entries.push(normalized.slice(starts[i], starts[i + 1] ?? normalized.length).trim());
	}
	return { entries, timestampDelimited: true };
}

function isUnmarkedInactiveHeader(entry: string, now: Date): boolean {
	if (!isInactiveMemoryEntry(entry, now)) return false;
	return entry.split("\n").every((line) => {
		const trimmed = line.trim();
		return (
			!trimmed ||
			/^#{1,6}\s+/.test(trimmed) ||
			/^<!--.*-->$/.test(trimmed) ||
			/^(?:[-*]\s*)?(?:Trust:|Status:|Valid until:?\s|Source:)/i.test(trimmed)
		);
	});
}

/** Apply trust, lifecycle, and secret policy to complete logical write entries. */
export function filterMemoryForContext(content: string, now = new Date()): string {
	const { entries, timestampDelimited } = splitLogicalMemoryEntries(content);
	const activeEntries: string[] = [];
	for (const entry of entries) {
		const inactive = isInactiveMemoryEntry(entry, now);
		if (!timestampDelimited && isUnmarkedInactiveHeader(entry, now)) {
			// Without write markers there is no reliable boundary after a metadata-only
			// header. Fail closed instead of treating the following body paragraphs as
			// independent trusted entries.
			break;
		}
		if (!inactive) activeEntries.push(entry);
	}
	return redactSecrets(activeEntries.join("\n\n")).content.trim();
}

function sanitizeSourceUri(sourceUri?: string): string | undefined {
	if (!sourceUri?.trim()) return undefined;
	const singleLine = [...sourceUri]
		.map((char) => {
			const code = char.charCodeAt(0);
			return code <= 31 || code === 127 ? " " : char;
		})
		.join("")
		.trim()
		.slice(0, 2_048);
	return redactSecrets(singleLine).content;
}

function escapeEntryMarkers(content: string): string {
	return content.replace(
		/^<!--\s*(?:last updated:\s*)?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]]+\]\s*-->$/gm,
		(line) => line.replace("<!--", "&lt;!--"),
	);
}

function formatStoredEntry(
	content: string,
	metadata: string,
	sourceUri?: string,
): { entry: string; redacted: boolean } {
	const safeContent = redactSecrets(escapeEntryMarkers(content));
	const source = sanitizeSourceUri(sourceUri);
	return {
		entry: `${metadata}\n${safeContent.content}${source ? `\nSource: ${source}` : ""}`,
		redacted: safeContent.redacted || (!!sourceUri && source !== sourceUri.trim()),
	};
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

function scratchpadContextSection(): string | null {
	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (!scratchpad?.trim()) return null;
	const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
	if (openItems.length === 0) return null;
	const serialized = filterMemoryForContext(serializeScratchpad(openItems));
	return formatContextSection(
		"## SCRATCHPAD.md (working context)",
		serialized,
		"start",
		CONTEXT_SCRATCHPAD_MAX_LINES,
		CONTEXT_SCRATCHPAD_MAX_CHARS,
	);
}

function todayContextSection(): string | null {
	const today = todayStr();
	const content = readFileSafe(dailyPath(today));
	const safe = content ? filterMemoryForContext(content) : "";
	if (!safe) return null;
	return formatContextSection(
		`## Daily log: ${today} (today)`,
		safe,
		"middle",
		CONTEXT_DAILY_MAX_LINES,
		CONTEXT_DAILY_MAX_CHARS,
	);
}

function yesterdayContextSection(): string | null {
	const yesterday = yesterdayStr();
	const content = readFileSafe(dailyPath(yesterday));
	const safe = content ? filterMemoryForContext(content) : "";
	if (!safe) return null;
	return formatContextSection(
		`## Daily log: ${yesterday} (yesterday)`,
		safe,
		"end",
		CONTEXT_DAILY_MAX_LINES,
		CONTEXT_DAILY_MAX_CHARS,
	);
}

function searchContextSection(searchResults?: string): string | null {
	const safe = searchResults ? filterMemoryForContext(searchResults) : "";
	if (!safe) return null;
	return formatContextSection(
		"## Relevant memories (auto-retrieved)",
		safe,
		"start",
		CONTEXT_SEARCH_MAX_LINES,
		CONTEXT_SEARCH_MAX_CHARS,
	);
}

function longTermContextSection(): string | null {
	const longTerm = readFileSafe(MEMORY_FILE);
	const safe = longTerm ? filterMemoryForContext(longTerm) : "";
	if (!safe) return null;
	return formatContextSection(
		"## MEMORY.md (long-term)",
		safe,
		"middle",
		CONTEXT_LONG_TERM_MAX_LINES,
		CONTEXT_LONG_TERM_MAX_CHARS,
	);
}

function assembleContext(sections: readonly (string | null)[]): string {
	const kept = sections.filter((s): s is string => !!s);
	if (kept.length === 0) return "";
	const context = `# Memory\n\n${kept.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const note = "\n\n[truncated overall context to 16000 chars]";
		return context.slice(0, CONTEXT_MAX_CHARS - note.length).trimEnd() + note;
	}
	return context;
}

/**
 * Full context: scratchpad + topics + today + search + MEMORY.md + yesterday.
 * Used by `agent-memory context` and by SessionStart in stable mode.
 */
export function buildMemoryContext(searchResults?: string): string {
	ensureDirs();
	return assembleContext([
		scratchpadContextSection(),
		buildTopicsContextSection(),
		todayContextSection(),
		searchContextSection(searchResults),
		longTermContextSection(),
		yesterdayContextSection(),
	]);
}

/**
 * Stable subset: scratchpad + topics + MEMORY.md. No daily logs, no search.
 * Emitted at SessionStart in per-turn mode — the durable facts that survive
 * across sessions and are unlikely to be affected by the current prompt.
 */
export function buildStableContext(): string {
	ensureDirs();
	return assembleContext([scratchpadContextSection(), buildTopicsContextSection(), longTermContextSection()]);
}

/**
 * Dynamic subset: today's daily log + qmd search hits + yesterday's daily log.
 * Emitted at UserPromptSubmit — turn-scoped context that can be scoped by the
 * current query. Excludes MEMORY.md and scratchpad (already sent at SessionStart).
 */
export function buildDynamicContext(searchResults?: string, _query?: string): string {
	ensureDirs();
	return assembleContext([todayContextSection(), searchContextSection(searchResults), yesterdayContextSection()]);
}

function buildTopicsContextSection(): string | null {
	let topicFiles: string[];
	try {
		topicFiles = fs
			.readdirSync(TOPICS_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		return null;
	}

	if (topicFiles.length === 0) return null;

	const entries: TopicEntry[] = [];
	for (const file of topicFiles) {
		const slug = file.replace(/\.md$/, "");
		const content = readFileSafe(path.join(TOPICS_DIR, file));
		const safeContent = content ? filterMemoryForContext(content) : "";
		if (!safeContent) continue;
		const titleMatch = safeContent.match(/^# Topic:\s*(.+)$/m);
		const title = titleMatch?.[1]?.trim() || slug;
		entries.push(...parseTopicEntries(title, slug, safeContent));
	}

	if (entries.length === 0) return null;

	const recent = sortRecentFirst(entries).slice(0, 8);
	const lines = recent.map((entry) => {
		const firstLine = entry.content.split("\n")[0].slice(0, 120);
		const suffix = entry.content.split("\n")[0].length > 120 ? "..." : "";
		const datePart = entry.date ? ` → [[${entry.date}]]` : "";
		return `- ${entry.topic}: ${firstLine}${suffix}${datePart}`;
	});

	return formatContextSection(
		"## Topics (recent)",
		lines.join("\n"),
		"start",
		CONTEXT_TOPICS_MAX_LINES,
		CONTEXT_TOPICS_MAX_CHARS,
	);
}

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;
type SpawnFn = typeof spawn;
let execFileFn: ExecFileFn = execFile;
let spawnFn: SpawnFn = spawn;

let qmdAvailable = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let embedTimer: ReturnType<typeof setTimeout> | null = null;
let skillsRootOverride: string | null = null;
let homeDirOverride: string | null = null;

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

/** Override skills root directory (for testing). */
export function _setSkillsRootForTest(dir: string | null) {
	skillsRootOverride = dir;
}

/** Override home directory (for testing). */
export function _setHomeDirForTest(dir: string | null) {
	homeDirOverride = dir;
}

/** Override spawn implementation (for testing). */
export function _setSpawnForTest(fn: SpawnFn) {
	spawnFn = fn;
}

/** Reset spawn implementation (for testing). */
export function _resetSpawnForTest() {
	spawnFn = spawn;
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

/** Get current embed timer (for testing). */
export function _getEmbedTimer(): ReturnType<typeof setTimeout> | null {
	return embedTimer;
}

/** Clear the embed timer (for testing). */
export function _clearEmbedTimer() {
	if (embedTimer) {
		clearTimeout(embedTimer);
		embedTimer = null;
	}
}

function resolveHomeDir(): string | null {
	if (homeDirOverride !== null) return homeDirOverride;
	return process.env.HOME ?? process.env.USERPROFILE ?? null;
}

function commandExists(cmd: string): boolean {
	const envPath = process.env.PATH ?? "";
	if (!envPath) return false;

	const dirs = envPath.split(path.delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const rawExts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM") : "";
	const exts = isWin ? rawExts.split(";").filter(Boolean) : [""];

	for (const dir of dirs) {
		for (const ext of exts) {
			const fileName = isWin ? `${cmd}${ext}` : cmd;
			const fullPath = path.join(dir, fileName);
			if (fs.existsSync(fullPath)) return true;
		}
	}

	return false;
}

function findSkillsRoot(): string | null {
	const envRoot = process.env.AGENT_MEMORY_SKILLS_ROOT;
	if (envRoot) return envRoot;
	if (skillsRootOverride) return skillsRootOverride;

	const scanUp = (startDir: string): string | null => {
		let dir = startDir;
		while (true) {
			if (fs.existsSync(path.join(dir, "skills"))) return dir;
			const parent = path.dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	};

	const realDirOf = (p: string): string => {
		try {
			return path.dirname(fs.realpathSync(p));
		} catch {
			return path.resolve(path.dirname(p));
		}
	};

	const argvPath = process.argv[1];
	if (argvPath) {
		const found = scanUp(realDirOf(argvPath));
		if (found) return found;
	}

	const execDir = realDirOf(process.execPath);
	const found = scanUp(execDir);
	if (found) return found;

	return scanUp(path.resolve(process.cwd()));
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
		["/topics", "Topic and event notes linked back to daily logs"],
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

export function detectQmd(options: { signal?: AbortSignal } = {}): Promise<boolean> {
	return new Promise((resolve) => {
		// qmd doesn't reliably support --version; use a fast command that exits 0 when available.
		execFileFn("qmd", ["status"], { timeout: 5_000, signal: options.signal }, (err) => {
			resolve(!err);
		});
	});
}

export function checkCollection(name?: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
	const collName = name ?? QMD_COLLECTION_NAME;
	return new Promise((resolve) => {
		execFileFn(
			"qmd",
			["collection", "list", "--json"],
			{ timeout: 10_000, signal: options.signal },
			(err, stdout) => {
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
			},
		);
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

export function getQmdEmbedMode(): "background" | "manual" | "off" {
	const mode = (process.env.AGENT_MEMORY_QMD_EMBED ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export function runQmdEmbedDetached(): ChildProcess | null {
	if (!qmdAvailable) return null;
	const child = spawnFn("qmd", ["embed"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return child;
}

export function scheduleQmdEmbed() {
	if (getQmdEmbedMode() !== "background") return;
	if (!qmdAvailable) return;
	if (embedTimer) clearTimeout(embedTimer);
	embedTimer = setTimeout(() => {
		embedTimer = null;
		runQmdEmbedDetached();
	}, 5_000);
	// Don't prevent process exit while waiting to embed
	if (embedTimer && typeof embedTimer === "object" && "unref" in embedTimer) {
		(embedTimer as NodeJS.Timeout).unref();
	}
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => {
			scheduleQmdEmbed();
		});
	}, 500);
}

export async function runQmdUpdateNow() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	await new Promise<void>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
}

export async function runQmdEmbedNow(): Promise<boolean> {
	if (!qmdAvailable) return false;
	return new Promise((resolve) => {
		execFileFn("qmd", ["embed"], { timeout: 120_000 }, (err) => {
			resolve(!err);
		});
	});
}

export async function ensureQmdAvailableForSync(options: { signal?: AbortSignal } = {}): Promise<boolean> {
	if (qmdAvailable) return true;
	qmdAvailable = await detectQmd(options);
	return qmdAvailable;
}

export async function runQmdSync(): Promise<{ updateOk: boolean; embedOk: boolean }> {
	if (!qmdAvailable) return { updateOk: false, embedOk: false };

	const updateOk = await new Promise<boolean>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, (err) => {
			resolve(!err);
		});
	});

	const embedOk = await runQmdEmbedNow();
	return { updateOk, embedOk };
}

export interface InstallSkillsReport {
	ok: boolean;
	projectDir?: string;
	homeDir?: string;
	checked: Array<{ label: string; status: "detected" | "skipped"; reason?: string }>;
	detected: Array<{ label: string; homeMarker: string }>;
	installed: Array<{ label: string; path: string }>;
	skipped: Array<{ label: string; reason: string }>;
	error?: string;
}

export function installSkills(): InstallSkillsReport {
	const homeDir = resolveHomeDir();
	if (!homeDir) {
		return {
			ok: false,
			detected: [],
			installed: [],
			skipped: [],
			checked: [],
			error: "Home directory not found. Set HOME (or USERPROFILE on Windows) and retry.",
		};
	}

	const projectDir = findSkillsRoot();
	if (!projectDir) {
		return {
			ok: false,
			homeDir,
			detected: [],
			installed: [],
			skipped: [],
			checked: [],
			error: "Could not locate the skills directory. Ensure the package includes skills/ (reinstall if needed).",
		};
	}

	const skillsDir = path.join(projectDir, "skills");
	if (!fs.existsSync(skillsDir)) {
		return {
			ok: false,
			projectDir,
			homeDir,
			detected: [],
			installed: [],
			skipped: [],
			checked: [],
			error: `Skills directory not found: ${skillsDir}`,
		};
	}
	const targets = [
		{
			label: "Claude Code skill",
			srcDir: path.join(skillsDir, "claude-code"),
			destDir: path.join(homeDir, ".claude", "skills", "agent-memory"),
			homeMarker: path.join(homeDir, ".claude"),
			detectFiles: [
				path.join(homeDir, ".claude", "settings.json"),
				path.join(homeDir, ".claude", "settings.local.json"),
			],
			detectCommand: "claude",
		},
		{
			label: "Codex skill",
			srcDir: path.join(skillsDir, "codex"),
			destDir: path.join(homeDir, ".codex", "skills", "agent-memory"),
			homeMarker: path.join(homeDir, ".codex"),
			detectFiles: [path.join(homeDir, ".codex", "config.toml")],
			detectCommand: "codex",
		},
		{
			label: "Cursor skill",
			srcDir: path.join(skillsDir, "cursor"),
			destDir: path.join(homeDir, ".cursor", "skills", "agent-memory"),
			homeMarker: path.join(homeDir, ".cursor"),
		},
		{
			label: "Agent CLI skill",
			srcDir: path.join(skillsDir, "agent"),
			destDir: path.join(homeDir, ".agents", "skills", "agent-memory"),
			homeMarker: path.join(homeDir, ".agents"),
		},
	];

	const detected: Array<{ label: string; homeMarker: string }> = [];
	const installed: Array<{ label: string; path: string }> = [];
	const skipped: Array<{ label: string; reason: string }> = [];
	const checked: Array<{ label: string; status: "detected" | "skipped"; reason?: string }> = [];

	for (const target of targets) {
		if (!fs.existsSync(target.homeMarker)) {
			skipped.push({ label: target.label, reason: `${target.homeMarker} not found` });
			checked.push({ label: target.label, status: "skipped", reason: `${target.homeMarker} not found` });
			continue;
		}
		const detectedByFile = (target.detectFiles ?? []).some((file) => fs.existsSync(file));
		const detectedByCommand = target.detectCommand ? commandExists(target.detectCommand) : false;
		const requiresDetection = (target.detectFiles?.length ?? 0) > 0 || !!target.detectCommand;
		if (requiresDetection && !detectedByFile && !detectedByCommand) {
			skipped.push({ label: target.label, reason: "not detected" });
			checked.push({ label: target.label, status: "skipped", reason: "not detected" });
			continue;
		}

		detected.push({ label: target.label, homeMarker: target.homeMarker });
		checked.push({ label: target.label, status: "detected" });

		const skillFile = path.join(target.srcDir, "SKILL.md");
		if (!fs.existsSync(skillFile)) {
			skipped.push({ label: target.label, reason: `${skillFile} not found` });
			continue;
		}

		fs.mkdirSync(target.destDir, { recursive: true });
		fs.copyFileSync(skillFile, path.join(target.destDir, "SKILL.md"));
		installed.push({ label: target.label, path: path.join(target.destDir, "SKILL.md") });
	}

	return {
		ok: true,
		projectDir,
		homeDir,
		checked,
		detected,
		installed,
		skipped,
	};
}

export interface UninstallSkillsReport {
	ok: boolean;
	homeDir?: string;
	removed: Array<{ label: string; path: string }>;
	skipped: Array<{ label: string; reason: string }>;
	error?: string;
}

export function uninstallSkills(): UninstallSkillsReport {
	const homeDir = resolveHomeDir();
	if (!homeDir) {
		return {
			ok: false,
			removed: [],
			skipped: [],
			error: "Home directory not found. Set HOME (or USERPROFILE on Windows) and retry.",
		};
	}

	const targets = [
		{ label: "Claude Code skill", destDir: path.join(homeDir, ".claude", "skills", "agent-memory") },
		{ label: "Codex skill", destDir: path.join(homeDir, ".codex", "skills", "agent-memory") },
		{ label: "Cursor skill", destDir: path.join(homeDir, ".cursor", "skills", "agent-memory") },
		{ label: "Agent CLI skill", destDir: path.join(homeDir, ".agents", "skills", "agent-memory") },
	];

	const removed: Array<{ label: string; path: string }> = [];
	const skipped: Array<{ label: string; reason: string }> = [];

	for (const target of targets) {
		const skillFile = path.join(target.destDir, "SKILL.md");
		if (fs.existsSync(skillFile)) {
			fs.unlinkSync(skillFile);
			// Clean up empty directory
			try {
				fs.rmdirSync(target.destDir);
			} catch {
				// directory not empty or already gone — fine
			}
			removed.push({ label: target.label, path: skillFile });
		} else {
			skipped.push({ label: target.label, reason: "not installed" });
		}
	}

	return { ok: true, homeDir, removed, skipped };
}

export interface QmdHealthInfo {
	totalFiles: number | null;
	vectorsEmbedded: number | null;
	pendingEmbed: number | null;
	lastUpdated: string | null;
	collectionFiles: number | null;
	collectionUpdated: string | null;
	embedMode: string;
}

export function parseQmdStatus(stdout: string, collectionName: string): QmdHealthInfo {
	const result: QmdHealthInfo = {
		totalFiles: null,
		vectorsEmbedded: null,
		pendingEmbed: null,
		lastUpdated: null,
		collectionFiles: null,
		collectionUpdated: null,
		embedMode: getQmdEmbedMode(),
	};

	if (!stdout.trim()) return result;

	// Total files across all collections
	const totalFilesMatch = stdout.match(/(\d+)\s+(?:total\s+)?files?/i);
	if (totalFilesMatch) {
		result.totalFiles = Number.parseInt(totalFilesMatch[1], 10);
	}

	// Vectors / embeddings
	const vectorsMatch = stdout.match(/(\d+)\s+(?:vectors?|embeddings?)/i);
	if (vectorsMatch) {
		result.vectorsEmbedded = Number.parseInt(vectorsMatch[1], 10);
	}

	// Pending embed
	const pendingMatch = stdout.match(/(\d+)\s+pending/i);
	if (pendingMatch) {
		result.pendingEmbed = Number.parseInt(pendingMatch[1], 10);
	}

	// If we have totalFiles and vectorsEmbedded but no explicit pending, infer it
	if (result.pendingEmbed === null && result.totalFiles !== null && result.vectorsEmbedded !== null) {
		result.pendingEmbed = Math.max(0, result.totalFiles - result.vectorsEmbedded);
	}

	// Last updated timestamp
	const updatedMatch = stdout.match(/(?:last\s+)?updated:?\s+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}[:\d]*)/i);
	if (updatedMatch) {
		result.lastUpdated = updatedMatch[1];
	}

	// Collection-specific info — look for collection name section
	const collectionPattern = new RegExp(`${collectionName}[:\\s]*(?:.*?)(\\d+)\\s+files?`, "i");
	const collMatch = stdout.match(collectionPattern);
	if (collMatch) {
		result.collectionFiles = Number.parseInt(collMatch[1], 10);
	}

	return result;
}

export async function getQmdHealth(): Promise<QmdHealthInfo | null> {
	if (!qmdAvailable) return null;

	return new Promise((resolve) => {
		execFileFn("qmd", ["status"], { timeout: 10_000 }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			resolve(parseQmdStatus(stdout ?? "", QMD_COLLECTION_NAME));
		});
	});
}

function resolveCaseInsensitivePath(root: string, relativePath: string): string | null {
	let current = root;
	for (const segment of relativePath.split(/[/\\]+/).filter(Boolean)) {
		if (segment === "." || segment === "..") return null;
		let children: string[];
		try {
			children = fs.readdirSync(current);
		} catch {
			return null;
		}
		const child =
			children.find((name) => name === segment) ??
			children.find((name) => name.toLowerCase() === segment.toLowerCase());
		if (!child) return null;
		current = path.join(current, child);
	}
	return current;
}

function resolveQmdSourcePath(filePath: string): string | null {
	const qmdUri = filePath.match(/^qmd:\/\/([^/]+)\/?(.*)$/i);
	let relativePath = qmdUri ? qmdUri[2] : filePath;
	if (relativePath.toLowerCase().startsWith(`${QMD_COLLECTION_NAME.toLowerCase()}/`)) {
		relativePath = relativePath.slice(QMD_COLLECTION_NAME.length + 1);
	}

	const root = path.resolve(MEMORY_DIR);
	if (path.isAbsolute(relativePath)) {
		const candidate = path.resolve(relativePath);
		if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
		return fs.existsSync(candidate) ? candidate : null;
	}
	return resolveCaseInsensitivePath(root, relativePath.replace(/^\/+/, ""));
}

function qmdResultPassesSourcePolicy(filePath: string | undefined, snippet: string): boolean {
	if (!filePath) return false;
	const sourcePath = resolveQmdSourcePath(filePath);
	if (!sourcePath) return false;
	const source = readFileSafe(sourcePath);
	if (!source) return false;

	const activeSource = filterMemoryForContext(source);
	// qmd truncates chunks with a trailing ellipsis, so requiring EVERY line to
	// substring-match the source is too strict (it fails on any truncated line).
	// We just need to verify the snippet came from THIS source and isn't stale.
	// Require at least one substantive line to match, and reject if none do.
	const stripTruncation = (line: string): string =>
		line
			.trim()
			.replace(/\s*\.\.\.\s*$/, "")
			.replace(/…\s*$/, "")
			.trim();
	const snippetLines = snippet
		.split("\n")
		.map(stripTruncation)
		.filter((line) => line.length >= 8);
	if (snippetLines.length === 0) return false;
	return snippetLines.some((line) => activeSource.includes(line));
}

const RECALL_TIMEOUT_MS = 8_000;
const RECALL_LIMIT = 3;
// Widen upstream so post-filtering (system/plugins/**) still leaves candidates.
const RECALL_QMD_WIDEN = 15;
const RECALL_EXCLUDE_PATH_FRAGMENTS = ["/system/plugins/", "system/plugins/"];

function qmdResultIsUserContent(r: QmdSearchResult): boolean {
	const p = getQmdResultPath(r);
	if (!p) return true;
	return !RECALL_EXCLUDE_PATH_FRAGMENTS.some((frag) => p.includes(frag));
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort();

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";
	if (options.signal?.aborted) controller.abort();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

	try {
		const hasCollection = await checkCollection(undefined, { signal: controller.signal });
		if (!hasCollection) return "";

		// Single `qmd query --no-rerank "lex: q\nvec: q"` invocation: qmd runs BM25 +
		// vector internally and fuses via RRF. ~1.5s vs 2.5s for two parallel calls.
		// No LLM query expansion, no LLM rerank — those add 2-6s and hurt named-entity
		// / temporal-reasoning recall (LongMemEval-S finding 2026-08-27).
		const deepResult = await Promise.race([
			runQmdSearch("deep", sanitized, RECALL_QMD_WIDEN, { signal: controller.signal }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("timeout"));
				}, RECALL_TIMEOUT_MS);
			}),
		]);

		const fused = deepResult.results.filter(qmdResultIsUserContent).slice(0, RECALL_LIMIT);
		if (fused.length === 0) return "";

		const snippets = fused
			.map((r) => {
				const text = filterMemoryForContext(getQmdResultText(r));
				if (!text) return null;
				const filePath = getQmdResultPath(r);
				if (!qmdResultPassesSourcePolicy(filePath, text)) return null;
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text}` : text;
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	context?: string;
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
	const text = r.content ?? r.chunk ?? r.snippet ?? "";
	const folderContext = r.context?.trim();
	let normalized = text.trimStart();
	if (folderContext) {
		const prefix = `Folder Context: ${folderContext}`;
		if (normalized.startsWith(prefix)) {
			const remainder = normalized.slice(prefix.length);
			if (/^(?:\r?\n){2}/.test(remainder)) {
				normalized = remainder.replace(/^(?:\r?\n){2}/, "");
			}
		}
	}

	return normalized.replace(/^@@ -\d+(?:,\d+)?(?: \+\d+(?:,\d+)?)? @@ \(\d+ before, \d+ after\)(?:\r?\n){1,2}/, "");
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
	options: { signal?: AbortSignal; collection?: string; index?: string } = {},
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	// Route through qmd's typed-query interface (`qmd query --no-rerank "lex: q\nvec: q"`)
	// so mode="deep" runs BM25 + vector in ONE qmd invocation (~1.5s) with internal
	// RRF fusion — vs two parallel invocations (~2.5s wall). Keyword and semantic modes
	// use the typed form too so behavior is uniform: no LLM query expansion, no
	// LLM rerank. That was the source of 8-9s hybrid latency + the temporal-reasoning
	// regression on LongMemEval-S (grep 83% vs expanded-hybrid 62%).
	// qmd's `vec:` grammar treats a leading `-` on a token as negation, which
	// blows up natural-language questions like "e-commerce" or "friends-and-
	// family". lex tolerates negation intentionally, but for vec we normalize
	// hyphens to spaces (and collapse whitespace) before injection.
	const vecSafe = query.replace(/-/g, " ").replace(/\s+/g, " ").trim() || query;
	let typedBody: string;
	if (mode === "keyword") typedBody = `lex: ${query}`;
	else if (mode === "semantic") typedBody = `vec: ${vecSafe}`;
	else typedBody = `lex: ${query}\nvec: ${vecSafe}`;
	const args: string[] = [];
	if (options.index) args.push("--index", options.index);
	args.push(
		"query",
		"--json",
		"--no-rerank",
		"-c",
		options.collection ?? QMD_COLLECTION_NAME,
		"-n",
		String(limit),
		typedBody,
	);

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: 60_000, signal: options.signal }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr?.trim() || err.message));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : ((parsed as any).results ?? (parsed as any).hits ?? []);
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

/**
 * Best-effort check of whether vector embeddings are actually usable for
 * semantic/deep search right now. Runs a tiny semantic probe and looks for
 * qmd's "need embeddings" warning. Bounded by a short timeout because the very
 * first semantic query can trigger a model download — returns "unknown" rather
 * than blocking on it. "ready" means the probe ran without the warning; it does
 * not prove the index has content.
 */
export async function probeEmbeddings(): Promise<"ready" | "missing" | "unknown"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Abort the underlying qmd child when the timeout fires so it does not keep
	// the event loop open until its own 60s timeout and hang the CLI.
	const controller = new AbortController();
	try {
		const { stderr } = await Promise.race([
			runQmdSearch("semantic", "memory", 1, { signal: controller.signal }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("timeout"));
				}, 4_000);
			}),
		]);
		return /need embeddings/i.test(stderr ?? "") ? "missing" : "ready";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/need embeddings/i.test(msg)) return "missing";
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Standalone tool functions
// ---------------------------------------------------------------------------

export interface ToolResult {
	text: string;
	details: Record<string, unknown>;
	isError?: boolean;
}

const LONG_TERM_SOFT_LINE_CAP = 50;
const LONG_TERM_DUPLICATE_THRESHOLD = 0.6;

function significantWords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/<!--.*?-->/gs, " ")
			.replace(/[`*_#>[\]()]/g, " ")
			.split(/\s+/)
			.filter((word) => word.length > 2),
	);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const word of a) {
		if (b.has(word)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

/** Cheap near-duplicate check against existing long_term entries — advisory only, never blocks the write. */
function findSimilarLongTermEntry(existingContent: string, newContent: string): string | null {
	const newWords = significantWords(newContent);
	if (newWords.size === 0) return null;
	const { entries } = splitLogicalMemoryEntries(existingContent);
	for (const entry of entries) {
		if (!entry.trim()) continue;
		if (jaccardSimilarity(newWords, significantWords(entry)) >= LONG_TERM_DUPLICATE_THRESHOLD) {
			return entry.trim();
		}
	}
	return null;
}

function longTermLineCapWarning(finalContent: string): string | null {
	const lineCount = finalContent.split("\n").length;
	if (lineCount <= LONG_TERM_SOFT_LINE_CAP) return null;
	return `MEMORY.md is now ${lineCount} lines, over the recommended ~${LONG_TERM_SOFT_LINE_CAP}-line cap — consider \`agent-memory distil\` to curate it back down.`;
}

export async function memoryWrite(params: {
	directory?: string;
	target?: "long_term" | "daily" | "topic";
	content: string;
	mode?: "append" | "overwrite";
	sessionId?: string;
	topic?: string;
	date?: string;
	sourceUri?: string;
}): Promise<ToolResult> {
	const memoryDir = params.directory ? path.resolve(params.directory) : getMemoryDir();
	fs.mkdirSync(memoryDir, { recursive: true });
	fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
	fs.mkdirSync(path.join(memoryDir, "topics"), { recursive: true });
	const scheduleSearchRefresh = async () => {
		if (path.resolve(getMemoryDir()) !== memoryDir) return;
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
	};
	const target = params.target ?? "daily";
	const { content, mode } = params;
	const sid = shortSessionId(params.sessionId ?? "cli");
	const ts = nowTimestamp();

	if (target === "daily") {
		const filePath = path.join(memoryDir, "daily", `${params.date?.trim() || todayStr()}.md`);
		const existing = readFileSafe(filePath) ?? "";
		const safeExisting = redactSecrets(existing).content;
		const existingPreview = buildPreview(safeExisting, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "end",
		});
		const existingSnippet = existingPreview.preview
			? `\n\n${formatPreviewBlock("Existing daily log preview", safeExisting, "end")}`
			: "\n\nDaily log was empty.";

		const separator = existing.trim() ? "\n\n" : "";
		const stored = formatStoredEntry(content, `<!-- ${ts} [${sid}] -->`, params.sourceUri);
		fs.writeFileSync(filePath, existing + separator + stored.entry, "utf-8");
		await scheduleSearchRefresh();
		return {
			text: `Appended to daily log: ${filePath}${existingSnippet}`,
			details: {
				path: filePath,
				target,
				mode: "append",
				sessionId: sid,
				timestamp: ts,
				sourceUri: sanitizeSourceUri(params.sourceUri),
				redacted: stored.redacted,
				qmdUpdateMode: getQmdUpdateMode(),
				existingPreview,
			},
		};
	}

	if (target === "topic") {
		const topic = params.topic?.trim();
		if (!topic) {
			return { text: "Error: 'topic' is required for target 'topic'.", details: {}, isError: true };
		}
		const slug = slugifyTopic(topic);
		if (!slug) {
			return { text: "Error: 'topic' must include at least one letter or number.", details: {}, isError: true };
		}
		const filePath = path.join(memoryDir, "topics", `${slug}.md`);
		const existing = readFileSafe(filePath) ?? "";
		const safeExisting = redactSecrets(existing).content;
		const existingPreview = buildPreview(safeExisting, {
			maxLines: RESPONSE_PREVIEW_MAX_LINES,
			maxChars: RESPONSE_PREVIEW_MAX_CHARS,
			mode: "end",
		});
		const existingSnippet = existingPreview.preview
			? `\n\n${formatPreviewBlock("Existing topic preview", safeExisting, "end")}`
			: "\n\nTopic file was empty.";

		const linkDate = params.date?.trim() || todayStr();
		const header = `# Topic: ${topic}\n\n<!-- created: ${ts} [${sid}] -->\n`;
		const separator = existing.trim() ? "\n\n" : "";
		const base = existing.trim() ? existing : header.trimEnd();
		const stored = formatStoredEntry(
			`${content.trim()}\nDaily: [[${linkDate}]]`,
			`<!-- ${ts} [${sid}] -->`,
			params.sourceUri,
		);
		fs.writeFileSync(filePath, `${base}${separator}${stored.entry}`, "utf-8");
		await scheduleSearchRefresh();
		return {
			text: `Appended to topic: ${filePath}${existingSnippet}`,
			details: {
				path: filePath,
				target,
				mode: "append",
				sessionId: sid,
				timestamp: ts,
				topic,
				slug,
				date: linkDate,
				sourceUri: sanitizeSourceUri(params.sourceUri),
				redacted: stored.redacted,
				qmdUpdateMode: getQmdUpdateMode(),
				existingPreview,
			},
		};
	}

	// long_term
	const memFile = path.join(memoryDir, "MEMORY.md");
	const existing = readFileSafe(memFile) ?? "";
	const safeExisting = redactSecrets(existing).content;
	const existingPreview = buildPreview(safeExisting, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode: "middle",
	});
	const existingSnippet = existingPreview.preview
		? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", safeExisting, "middle")}`
		: "\n\nMEMORY.md was empty.";

	if (mode === "overwrite") {
		const stored = formatStoredEntry(content, `<!-- last updated: ${ts} [${sid}] -->`, params.sourceUri);
		fs.writeFileSync(memFile, stored.entry, "utf-8");
		await scheduleSearchRefresh();
		const warnings = [longTermLineCapWarning(stored.entry)].filter((w): w is string => w !== null);
		return {
			text: `Overwrote MEMORY.md${warnings.length ? `\n\n${warnings.join("\n\n")}` : ""}${existingSnippet}`,
			details: {
				path: memFile,
				target,
				mode: "overwrite",
				sessionId: sid,
				timestamp: ts,
				sourceUri: sanitizeSourceUri(params.sourceUri),
				redacted: stored.redacted,
				qmdUpdateMode: getQmdUpdateMode(),
				existingPreview,
				warnings,
			},
		};
	}

	// append (default)
	const similarEntry = findSimilarLongTermEntry(existing, content);
	const separator = existing.trim() ? "\n\n" : "";
	const stored = formatStoredEntry(content, `<!-- ${ts} [${sid}] -->`, params.sourceUri);
	const merged = existing + separator + stored.entry;
	fs.writeFileSync(memFile, merged, "utf-8");
	await scheduleSearchRefresh();
	const warnings = [
		similarEntry
			? `Possible duplicate — an existing entry looks similar:\n${buildPreview(similarEntry, { maxLines: 4, maxChars: 300, mode: "start" }).preview}\nConsider \`--mode overwrite\` to curate instead of appending a near-duplicate.`
			: null,
		longTermLineCapWarning(merged),
	].filter((w): w is string => w !== null);
	return {
		text: `Appended to MEMORY.md${warnings.length ? `\n\n${warnings.join("\n\n")}` : ""}${existingSnippet}`,
		details: {
			path: memFile,
			target,
			mode: "append",
			sessionId: sid,
			timestamp: ts,
			sourceUri: sanitizeSourceUri(params.sourceUri),
			redacted: stored.redacted,
			qmdUpdateMode: getQmdUpdateMode(),
			existingPreview,
			warnings,
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
	let items = parseScratchpad(existing).map((item) => ({
		...item,
		text: redactSecrets(item.text).content,
		meta: redactSecrets(item.meta).content,
	}));

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
		const safeText = redactSecrets(text).content;
		items.push({ done: false, text: safeText, meta: `<!-- ${ts} [${sid}] -->` });
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
			text: `Added: - [ ] ${safeText}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
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
	target: "long_term" | "scratchpad" | "daily" | "list" | "topic" | "topics";
	date?: string;
	topic?: string;
}): Promise<ToolResult> {
	ensureDirs();
	const { target, date, topic } = params;

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

	if (target === "topics") {
		try {
			const files = fs
				.readdirSync(getTopicsDir())
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (files.length === 0) {
				return { text: "No topics found.", details: {} };
			}
			return {
				text: `Topics:\n${files.map((f) => `- ${f}`).join("\n")}`,
				details: { files },
			};
		} catch {
			return { text: "No topics directory.", details: {} };
		}
	}

	if (target === "topic") {
		const name = topic?.trim();
		if (!name) {
			return { text: "Error: 'topic' is required for target 'topic'.", details: {}, isError: true };
		}
		const slug = slugifyTopic(name);
		const filePath = topicPath(slug);
		const content = readFileSafe(filePath);
		if (!content) {
			return { text: `No topic file found for ${name}.`, details: {} };
		}
		return { text: content, details: { path: filePath, topic: name, slug } };
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

// ---------------------------------------------------------------------------
// Distil — extraction helpers
// ---------------------------------------------------------------------------

/** Extract #tag patterns, deduplicated and lowercased. */
export function extractTags(content: string): string[] {
	const matches = content.match(/(?:^|\s)#([a-zA-Z][\w-]*)/g);
	if (!matches) return [];
	const tags = new Set(matches.map((m) => m.trim().toLowerCase()));
	return [...tags].sort();
}

/** Extract [[link]] patterns. */
export function extractLinks(content: string): string[] {
	const matches = content.match(/\[\[([^\]]+)\]\]/g);
	if (!matches) return [];
	const links = new Set(matches.map((m) => m.slice(2, -2).trim()));
	return [...links].sort();
}

/** Extract file-path-like patterns (e.g. src/foo.ts), filtering out URLs. */
export function extractFilePaths(content: string): string[] {
	const matches = content.match(/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g);
	if (!matches) return [];
	const paths = new Set<string>();
	for (const m of matches) {
		const p = m.trim();
		// Skip URLs
		if (p.startsWith("http://") || p.startsWith("https://") || p.startsWith("//")) continue;
		paths.add(p);
	}
	return [...paths].sort();
}

/** Extract backtick-quoted commands. */
export function extractCommands(content: string): string[] {
	const matches = content.match(/`([^`]+)`/g);
	if (!matches) return [];
	const cmds = new Set(matches.map((m) => m.slice(1, -1).trim()).filter((c) => c.length > 2 && c.includes(" ")));
	return [...cmds];
}

// ---------------------------------------------------------------------------
// Distil — daily entry parsing
// ---------------------------------------------------------------------------

export interface DailyEntry {
	date: string;
	timestamp: string;
	sessionId: string;
	content: string;
	tags: string[];
	links: string[];
	filePaths: string[];
	commands: string[];
}

/** Split a daily file on <!-- timestamp --> markers into individual entries. */
export function parseDailyEntries(date: string, content: string): DailyEntry[] {
	const entries: DailyEntry[] = [];
	// Split on timestamp markers: <!-- 2026-02-21 14:30:00 [sid] -->
	const parts = content.split(/(?=<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[)/);

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		const metaMatch = trimmed.match(/^<!-- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]]*)\] -->/);
		const timestamp = metaMatch?.[1] ?? "";
		const sessionId = metaMatch?.[2] ?? "";
		const body = metaMatch ? trimmed.slice(metaMatch[0].length).trim() : trimmed;
		if (!body) continue;

		entries.push({
			date,
			timestamp,
			sessionId,
			content: body,
			tags: extractTags(body),
			links: extractLinks(body),
			filePaths: extractFilePaths(body),
			commands: extractCommands(body),
		});
	}

	return entries;
}

export interface TopicEntry {
	topic: string;
	slug: string;
	date: string;
	timestamp: string;
	sessionId: string;
	content: string;
	tags: string[];
	links: string[];
	filePaths: string[];
	commands: string[];
}

function stripDailyLinkLines(content: string): string {
	const lines = content.split("\n");
	const filtered = lines.filter(
		(line) =>
			!/^\s*Daily:\s*\[\[\d{4}-\d{2}-\d{2}\]\]\s*$/i.test(line) && !/^\s*\[\[\d{4}-\d{2}-\d{2}\]\]\s*$/i.test(line),
	);
	const cleaned = filtered.join("\n").trim();
	return cleaned || content.trim();
}

/** Split a topic file on <!-- timestamp --> markers into entries. */
export function parseTopicEntries(topic: string, slug: string, content: string): TopicEntry[] {
	const entries: TopicEntry[] = [];
	const parts = content.split(/(?=<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[)/);

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		const metaMatch = trimmed.match(/^<!-- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]]*)\] -->/);
		if (!metaMatch) continue;

		const timestamp = metaMatch[1] ?? "";
		const sessionId = metaMatch[2] ?? "";
		const body = trimmed.slice(metaMatch[0].length).trim();
		if (!body) continue;

		const dateMatch = body.match(/\[\[(\d{4}-\d{2}-\d{2})\]\]/);
		const date = dateMatch?.[1] ?? timestamp.slice(0, 10);
		const cleaned = stripDailyLinkLines(body);

		entries.push({
			topic,
			slug,
			date,
			timestamp,
			sessionId,
			content: cleaned,
			tags: extractTags(cleaned),
			links: extractLinks(cleaned),
			filePaths: extractFilePaths(cleaned),
			commands: extractCommands(cleaned),
		});
	}

	return entries;
}

// ---------------------------------------------------------------------------
// Distil — main function
// ---------------------------------------------------------------------------

export interface DistilResult {
	ok: boolean;
	dryRun: boolean;
	totalDailyFiles: number;
	totalTopicFiles: number;
	totalEntries: number;
	totalTopicEntries: number;
	totalTags: number;
	tagCounts: Record<string, number>;
	output: string;
}

/** Summarize entry content: first line, truncated at 80 chars. */
type DistilEntry = DailyEntry | TopicEntry;

function summarizeEntry(entry: DistilEntry): string {
	const firstLine = entry.content.split("\n")[0].slice(0, 80);
	const suffix = entry.content.split("\n")[0].length > 80 ? "..." : "";
	return `${firstLine}${suffix}`;
}

/** Sort entries recent-first by date then timestamp. */
function sortRecentFirst<T extends { date: string; timestamp: string }>(entries: T[]): T[] {
	return [...entries].sort((a, b) => {
		if (a.date !== b.date) return b.date.localeCompare(a.date);
		return b.timestamp.localeCompare(a.timestamp);
	});
}

function entryKey(entry: DistilEntry): string {
	const base = `${entry.date}:${entry.timestamp}:${entry.sessionId}`;
	return "topic" in entry ? `topic:${entry.slug}:${base}` : `daily:${base}`;
}

export async function distilMemories(params?: { dryRun?: boolean; sessionId?: string }): Promise<DistilResult> {
	ensureDirs();
	const dryRun = params?.dryRun ?? false;

	// 1. Read all daily + topic files
	let dailyFiles: string[];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}

	let topicFiles: string[];
	try {
		topicFiles = fs
			.readdirSync(TOPICS_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		topicFiles = [];
	}

	if (dailyFiles.length === 0 && topicFiles.length === 0) {
		return {
			ok: true,
			dryRun,
			totalDailyFiles: 0,
			totalTopicFiles: 0,
			totalEntries: 0,
			totalTopicEntries: 0,
			totalTags: 0,
			tagCounts: {},
			output: "# Memory Index\n\nNo daily logs or topics to distil.\n",
		};
	}

	// 2. Parse all entries
	const allEntries: DistilEntry[] = [];
	for (const file of dailyFiles) {
		const date = file.replace(/\.md$/, "");
		const content = readFileSafe(path.join(DAILY_DIR, file));
		if (!content?.trim()) continue;
		const safeContent = filterMemoryForContext(content);
		if (!safeContent) continue;
		allEntries.push(...parseDailyEntries(date, safeContent));
	}
	const topicEntriesByTopic = new Map<string, TopicEntry[]>();
	let totalTopicEntries = 0;
	for (const file of topicFiles) {
		const slug = file.replace(/\.md$/, "");
		const content = readFileSafe(path.join(TOPICS_DIR, file));
		if (!content?.trim()) continue;
		const safeContent = filterMemoryForContext(content);
		if (!safeContent) continue;
		const titleMatch = safeContent.match(/^# Topic:\s*(.+)$/m);
		const title = titleMatch?.[1]?.trim() || slug;
		const entries = parseTopicEntries(title, slug, safeContent);
		if (entries.length === 0) continue;
		totalTopicEntries += entries.length;
		allEntries.push(...entries);
		topicEntriesByTopic.set(title, entries);
	}

	if (allEntries.length === 0) {
		return {
			ok: true,
			dryRun,
			totalDailyFiles: dailyFiles.length,
			totalTopicFiles: topicFiles.length,
			totalEntries: 0,
			totalTopicEntries: 0,
			totalTags: 0,
			tagCounts: {},
			output: "# Memory Index\n\nNo entries found in daily logs or topics.\n",
		};
	}

	// 3. Build tag → entries map and tag → dates map
	const tagEntries = new Map<string, DistilEntry[]>();
	const tagDates = new Map<string, Set<string>>();
	const untagged: DistilEntry[] = [];

	for (const entry of allEntries) {
		if (entry.tags.length === 0) {
			untagged.push(entry);
		} else {
			for (const tag of entry.tags) {
				if (!tagEntries.has(tag)) tagEntries.set(tag, []);
				tagEntries.get(tag)!.push(entry);
				if (!tagDates.has(tag)) tagDates.set(tag, new Set());
				tagDates.get(tag)!.add(entry.date);
			}
		}
	}

	// Sort tags by entry count (most used first), take top 15 for sections
	const sortedTags = [...tagEntries.entries()].sort((a, b) => b[1].length - a[1].length);
	const sectionTags = sortedTags.slice(0, 15);
	const indexTags = sortedTags.slice(0, 20);

	// 4. Preserve existing ## Pinned section from MEMORY.md
	let pinnedSection = "";
	const existingMemory = readFileSafe(MEMORY_FILE);
	if (existingMemory) {
		const safeExistingMemory = filterMemoryForContext(existingMemory);
		const pinnedMatch = safeExistingMemory.match(/## Pinned\n([\s\S]*?)(?=\n## |\n# |$)/);
		if (pinnedMatch) {
			pinnedSection = pinnedMatch[1].trim();
		}
	}

	// 5. Generate output
	const lines: string[] = [];
	const ts = nowTimestamp();
	lines.push("# Memory Index");
	lines.push(`<!-- last distilled: ${ts} -->`);
	lines.push("");

	// Pinned section
	if (pinnedSection) {
		lines.push("## Pinned");
		lines.push(pinnedSection);
		lines.push("");
	}

	// Topics section — list topics with latest entry summary
	if (topicEntriesByTopic.size > 0) {
		lines.push("## Topics");
		const sortedTopics = [...topicEntriesByTopic.entries()].sort((a, b) => b[1].length - a[1].length);
		for (const [topic, entries] of sortedTopics) {
			const recent = sortRecentFirst(entries)[0];
			const summary = summarizeEntry(recent);
			const dateLink = recent.date ? `[[${recent.date}]]` : "";
			const filePath = `topics/${entries[0].slug}.md`;
			const parts = [
				`${topic} — ${summary}`,
				dateLink ? `→ ${dateLink}` : "",
				`(${entries.length} entries)`,
				`(${filePath})`,
			].filter(Boolean);
			lines.push(`- ${parts.join(" ")}`);
		}
		lines.push("");
	}

	// Tag-based sections — top tags become section headers, each capped at 3 entries
	const tagCounts: Record<string, number> = {};
	const shownEntryIds = new Set<string>();

	for (const [tag, entries] of sectionTags) {
		tagCounts[tag] = entries.length;
		lines.push(`## ${tag}`);
		const recent = sortRecentFirst(entries).slice(0, 3);
		for (const entry of recent) {
			const entryId = entryKey(entry);
			shownEntryIds.add(entryId);
			lines.push(`- ${summarizeEntry(entry)} → [[${entry.date}]]`);
		}
		lines.push("");
	}

	// Recent untagged entries (up to 5, not already shown)
	const unseenUntagged = sortRecentFirst(untagged)
		.filter((e) => !shownEntryIds.has(entryKey(e)))
		.slice(0, 5);
	if (unseenUntagged.length > 0) {
		lines.push("## Recent");
		for (const entry of unseenUntagged) {
			lines.push(`- ${summarizeEntry(entry)} → [[${entry.date}]]`);
		}
		lines.push("");
	}

	// Tag index — all tags with their dates
	if (indexTags.length > 0) {
		lines.push("## Tags");
		for (const [tag] of indexTags) {
			const dates = tagDates.get(tag)!;
			const recentDates = [...dates].sort().reverse().slice(0, 5);
			lines.push(`${tag} → ${recentDates.join(", ")}`);
		}
		lines.push("");
	}

	const output = lines.join("\n");

	// 6. Write if not dry-run
	if (!dryRun) {
		fs.writeFileSync(MEMORY_FILE, output, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
	}

	return {
		ok: true,
		dryRun,
		totalDailyFiles: dailyFiles.length,
		totalTopicFiles: topicFiles.length,
		totalEntries: allEntries.length,
		totalTopicEntries,
		totalTags: indexTags.length,
		tagCounts,
		output,
	};
}
