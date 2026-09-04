import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getMemoryDir, type HookMode, writeHookMode } from "./core.js";

type ExecFileSyncFn = typeof execFileSync;
let execFileSyncFn: ExecFileSyncFn = execFileSync;

/** Override the execFileSync implementation used by hook installers (for testing). */
export function _setHookExecForTest(fn: ExecFileSyncFn): void {
	execFileSyncFn = fn;
}

/** Reset the execFileSync implementation to the real one. */
export function _resetHookExecForTest(): void {
	execFileSyncFn = execFileSync;
}

let homeDirOverride: string | null = null;

/** Override the detected home directory in deterministic tests. */
export function _setHookHomeDirForTest(directory: string | null): void {
	homeDirOverride = directory;
}

function resolveHomeDir(): string | null {
	if (homeDirOverride !== null) return homeDirOverride;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
	return home && home !== "~" ? home : null;
}

function commandExists(command: string): boolean {
	const envPath = process.env.PATH ?? "";
	if (!envPath) return false;
	const extensions =
		process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
	for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const filename = process.platform === "win32" ? `${command}${extension}` : command;
			try {
				fs.accessSync(path.join(directory, filename), fs.constants.X_OK);
				return true;
			} catch {}
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Hook installers (SessionStart auto-injection)
// ---------------------------------------------------------------------------

export type HookAgentKey = "claude" | "codex" | "cursor" | "opencode" | "pi" | "qoder";

export interface HookTargetInfo {
	key: HookAgentKey;
	label: string;
	homeMarker: string;
	detectFiles: string[];
	detectCommand?: string;
	supported: boolean;
	unsupportedReason?: string;
}

export interface DetectedHookTarget extends HookTargetInfo {
	detected: boolean;
	detectReason?: string;
}

const HOOK_MARKER_JSON = "_agentMemory";
const HOOK_MARKER_BEGIN = "# BEGIN agent-memory hook";
const HOOK_MARKER_END = "# END agent-memory hook";

function sessionStartHookCommand(agent: "claude" | "codex"): string {
	return `agent-memory hook session-start --agent ${agent}`;
}

function userPromptSubmitHookCommand(agent: "claude" | "codex"): string {
	return `agent-memory hook user-prompt-submit --agent ${agent}`;
}

function stopHookCommand(agent: "claude"): string {
	return `agent-memory hook stop --agent ${agent}`;
}

function hookTargets(homeDir: string): HookTargetInfo[] {
	return [
		{
			key: "claude",
			label: "Claude Code",
			homeMarker: path.join(homeDir, ".claude"),
			detectFiles: [
				path.join(homeDir, ".claude", "settings.json"),
				path.join(homeDir, ".claude", "settings.local.json"),
			],
			detectCommand: "claude",
			supported: true,
		},
		{
			key: "codex",
			label: "Codex",
			homeMarker: path.join(homeDir, ".codex"),
			detectFiles: [path.join(homeDir, ".codex", "config.toml")],
			detectCommand: "codex",
			supported: true,
		},
		{
			key: "cursor",
			label: "Cursor",
			homeMarker: path.join(homeDir, ".cursor"),
			detectFiles: [],
			supported: true,
		},
		{
			key: "opencode",
			label: "opencode",
			homeMarker: path.join(homeDir, ".config", "opencode"),
			detectFiles: [path.join(homeDir, ".config", "opencode", "opencode.json")],
			detectCommand: "opencode",
			supported: true,
		},
		{
			key: "pi",
			label: "pi (via pi-memory)",
			homeMarker: path.join(homeDir, ".pi"),
			detectFiles: [],
			detectCommand: "pi",
			supported: true,
		},
		{
			key: "qoder",
			label: "Qoder",
			homeMarker: path.join(homeDir, ".qoder"),
			detectFiles: [
				path.join(homeDir, ".qoder", "settings.json"),
				path.join(homeDir, ".qoder", "settings.local.json"),
			],
			detectCommand: "qoder",
			supported: true,
		},
	];
}

function hasClaudeHookGroup(homeDir: string, eventKey: string, command: string): boolean {
	const settingsPath = path.join(homeDir, ".claude", "settings.json");
	if (!fs.existsSync(settingsPath)) return false;
	const settings = readJsonConfig(settingsPath);
	const hooks = (settings.hooks as Record<string, unknown>) ?? {};
	const groups = Array.isArray(hooks[eventKey]) ? (hooks[eventKey] as unknown[]) : [];
	for (const group of groups) {
		if (!group || typeof group !== "object") continue;
		const g = group as Record<string, unknown>;
		const list = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [];
		for (const hook of list) {
			if (!hook || typeof hook !== "object") continue;
			const h = hook as Record<string, unknown>;
			// Match by command alone (marker is optional) — legacy entries that
			// predate HOOK_MARKER_JSON already run this exact command, and the
			// command string is specific enough to agent-memory that it's a safe
			// signal on its own. Otherwise a pre-marker install is invisible here,
			// doctor/isHookInstalled falsely report "not installed" for hooks that
			// are actually live, and upsertClaudeHookGroup can't find them to dedupe.
			if (h.command === command) return true;
		}
	}
	return false;
}

/**
 * Read-only check whether the SessionStart hook for `key` is already present in
 * the user's config. Mirrors each installer's "already installed" detection so
 * the CLI can avoid prompting for hooks that don't need to be installed.
 */
export function isHookInstalled(homeDir: string, key: HookAgentKey): boolean {
	try {
		if (key === "claude") return hasClaudeHookGroup(homeDir, "SessionStart", sessionStartHookCommand("claude"));
		if (key === "codex") {
			const configPath = path.join(homeDir, ".codex", "config.toml");
			if (!fs.existsSync(configPath)) return false;
			const existing = fs.readFileSync(configPath, "utf-8");
			if (!existing.includes(HOOK_MARKER_BEGIN)) return false;
			const command = sessionStartHookCommand("codex");
			return existing.includes(`command = "${command}"`);
		}
		if (key === "cursor") {
			return isCursorSessionStartHookRegistered(homeDir);
		}
		if (key === "opencode") {
			const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
			if (!fs.existsSync(configPath)) return false;
			const config = readJsonConfig(configPath);
			const raw = config.instructions;
			const list = Array.isArray(raw) ? (raw as unknown[]) : [];
			const instructionsPath = path.join(homeDir, ".agent-memory", "hooks", "opencode.md");
			return list.includes(instructionsPath);
		}
		if (key === "pi") {
			// Live filesystem state is authoritative — pi-memory can be installed or
			// removed outside agent-memory (manually, or via `pi uninstall`) at any
			// time, so a recorded delegate attempt must never override what's
			// actually on disk. The state file is diagnostic-only (surfaced
			// separately in `doctor`'s detail text), not a substitute for this check.
			return fs.existsSync(path.join(homeDir, ".pi", "agent", "memory"));
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * Read-only check whether the per-turn UserPromptSubmit hook is present.
 * Only Claude Code and Codex support a per-prompt hook; cursor/opencode
 * always return false (static rules only).
 */
export function isUserPromptSubmitInstalled(homeDir: string, key: HookAgentKey): boolean {
	try {
		if (key === "claude")
			return hasClaudeHookGroup(homeDir, "UserPromptSubmit", userPromptSubmitHookCommand("claude"));
		if (key === "codex") {
			const configPath = path.join(homeDir, ".codex", "config.toml");
			if (!fs.existsSync(configPath)) return false;
			const existing = fs.readFileSync(configPath, "utf-8");
			if (!existing.includes(HOOK_MARKER_BEGIN)) return false;
			return existing.includes(`command = "${userPromptSubmitHookCommand("codex")}"`);
		}
	} catch {}
	return false;
}

/**
 * Read-only check whether the periodic Stop-hook memory-write nudge is present.
 * Claude Code only — Codex/Cursor/opencode don't have a confirmed equivalent
 * block/reason protocol for this event yet.
 */
export function isStopHookInstalled(homeDir: string, key: HookAgentKey): boolean {
	try {
		if (key === "claude") return hasClaudeHookGroup(homeDir, "Stop", stopHookCommand("claude"));
	} catch {}
	return false;
}

export function detectHookAgents(): { homeDir: string | null; targets: DetectedHookTarget[] } {
	const homeDir = resolveHomeDir();
	if (!homeDir) return { homeDir: null, targets: [] };
	const targets = hookTargets(homeDir).map<DetectedHookTarget>((target) => {
		if (!fs.existsSync(target.homeMarker)) {
			return { ...target, detected: false, detectReason: `${target.homeMarker} not found` };
		}
		const byFile = target.detectFiles.some((f) => fs.existsSync(f));
		const byCommand = target.detectCommand ? commandExists(target.detectCommand) : false;
		const requires = target.detectFiles.length > 0 || !!target.detectCommand;
		if (requires && !byFile && !byCommand) {
			return { ...target, detected: false, detectReason: "not detected" };
		}
		return { ...target, detected: true };
	});
	return { homeDir, targets };
}

export interface HookInstallResult {
	key: HookAgentKey;
	label: string;
	installed: boolean;
	path?: string;
	backup?: string;
	reason?: string;
	mode?: HookMode;
}

export interface InstallHooksReport {
	ok: boolean;
	homeDir?: string;
	results: HookInstallResult[];
	error?: string;
}

function backupOnce(filePath: string): string | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const backupPath = `${filePath}.agent-memory.bak`;
	if (!fs.existsSync(backupPath)) {
		fs.copyFileSync(filePath, backupPath);
	}
	return backupPath;
}

function readJsonConfig(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		parsed = raw.trim() ? JSON.parse(raw) : {};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot modify invalid JSON config ${filePath}: ${detail}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`cannot modify JSON config ${filePath}: root value must be an object`);
	}
	return parsed as Record<string, unknown>;
}

function writeJson(filePath: string, data: unknown) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// pi hook support (delegates to the pi-memory extension rather than editing
// a JSON/TOML hook config — pi's extensibility model is a registered .ts
// extension, installed via its own package manager).
// ---------------------------------------------------------------------------

export interface PiMemoryState {
	lastAttemptAt: string;
	ok: boolean;
	detail: string;
}

function piMemoryStatePath(): string {
	return path.join(getMemoryDir(), "pi-memory-state.json");
}

function writePiMemoryState(ok: boolean, detail: string): void {
	try {
		writeJson(piMemoryStatePath(), { lastAttemptAt: new Date().toISOString(), ok, detail });
	} catch {
		// best-effort bookkeeping only — never block the actual install/uninstall result on this.
	}
}

/** Read the last recorded `pi install npm:pi-memory` attempt, if any. Never throws. */
export function getPiMemoryState(): PiMemoryState | null {
	try {
		const filePath = piMemoryStatePath();
		if (!fs.existsSync(filePath)) return null;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (typeof parsed?.lastAttemptAt !== "string" || typeof parsed?.ok !== "boolean") return null;
		return { lastAttemptAt: parsed.lastAttemptAt, ok: parsed.ok, detail: String(parsed.detail ?? "") };
	} catch {
		return null;
	}
}

function installPiMemoryDelegate(homeDir: string): HookInstallResult {
	const memoryPath = path.join(homeDir, ".pi", "agent", "memory");
	try {
		const stdout = execFileSyncFn("pi", ["install", "npm:pi-memory"], {
			encoding: "utf-8",
			timeout: 30_000,
		});
		const detail = typeof stdout === "string" ? stdout.trim() : "";
		writePiMemoryState(true, detail);
		return { key: "pi", label: "pi (via pi-memory)", installed: true, path: memoryPath, reason: detail || undefined };
	} catch (err) {
		const detail =
			err && typeof err === "object" && "stderr" in err && err.stderr
				? String(err.stderr).trim()
				: err instanceof Error
					? err.message
					: String(err);
		writePiMemoryState(false, detail);
		return { key: "pi", label: "pi (via pi-memory)", installed: false, reason: detail };
	}
}

function uninstallPiMemoryDelegate(homeDir: string): HookInstallResult {
	// agent-memory never owns this install, so it never runs `pi uninstall pi-memory` — but
	// silently doing nothing would let an `agent-memory uninstall` report read as "fully cleaned
	// up" while pi-memory keeps running. Phrase the reason distinctly when it's actually still
	// active so callers (and cmdUninstall's step detail) can surface that honestly.
	const stillActive = fs.existsSync(path.join(homeDir, ".pi", "agent", "memory"));
	return {
		key: "pi",
		label: "pi (via pi-memory)",
		installed: false,
		reason: stillActive
			? "pi-memory left installed (not managed by agent-memory) — run `pi uninstall pi-memory` to remove it"
			: "not installed",
	};
}

/**
 * Idempotently upsert the agent-memory-managed hook group for `eventKey`
 * (SessionStart or UserPromptSubmit) with `command`. Returns `{ changed,
 * hadManaged }` so the caller can decide between "installed" / "updated" /
 * "already installed" reasons.
 */
function upsertClaudeHookGroup(
	hooks: Record<string, unknown>,
	eventKey: string,
	command: string,
): { changed: boolean; hadManaged: boolean } {
	const groups = Array.isArray(hooks[eventKey]) ? [...(hooks[eventKey] as unknown[])] : [];

	// Locate every agent-memory-owned hook entry — matched by marker, or by
	// exact command string for legacy pre-marker installs — wherever it lives.
	const owned: Array<{ group: Record<string, unknown>; hook: Record<string, unknown> }> = [];
	for (const group of groups) {
		if (!group || typeof group !== "object") continue;
		const g = group as Record<string, unknown>;
		const list = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [];
		for (const hook of list) {
			if (!hook || typeof hook !== "object") continue;
			const h = hook as Record<string, unknown>;
			if (h[HOOK_MARKER_JSON] === true || h.command === command) owned.push({ group: g, hook: h });
		}
	}

	if (owned.length === 0) {
		// No existing managed hook anywhere — add a fresh group without a matcher so it fires on all harnesses.
		groups.push({ hooks: [{ type: "command", command, [HOOK_MARKER_JSON]: true }] });
		hooks[eventKey] = groups;
		return { changed: true, hadManaged: false };
	}

	// Keep the first owned entry in place — fixed up in place, preserving its
	// identity so a no-op re-install reports unchanged — and remove every
	// other owned entry from its own group's hooks array, whether it's a
	// duplicate in another group or piled up alongside the keeper in the same
	// group. Never delete a whole group, since it could carry unrelated
	// hand-added hooks.
	const keeper = owned[0];
	let changed = false;
	if (keeper.hook.command !== command) {
		keeper.hook.command = command;
		changed = true;
	}
	if (keeper.hook[HOOK_MARKER_JSON] !== true) {
		keeper.hook[HOOK_MARKER_JSON] = true;
		changed = true;
	}
	for (const dupe of owned.slice(1)) {
		const list = dupe.group.hooks as unknown[];
		const idx = list.indexOf(dupe.hook);
		if (idx !== -1) list.splice(idx, 1);
		changed = true;
	}

	// Only clear the keeper's group matcher when that group is exclusively
	// ours (no unrelated hooks left in it after dedup) — never when it also
	// carries an unrelated hand-added hook.
	const keeperList = keeper.group.hooks as unknown[];
	if (keeperList.length === 1 && "matcher" in keeper.group) {
		delete keeper.group.matcher;
		changed = true;
	}

	// Drop any group left with zero hooks; never drop one that still has
	// unrelated hooks in it.
	const filtered = groups.filter((group) => {
		if (!group || typeof group !== "object") return true;
		const g = group as Record<string, unknown>;
		return !Array.isArray(g.hooks) || (g.hooks as unknown[]).length > 0;
	});
	hooks[eventKey] = filtered;
	return { changed, hadManaged: true };
}

/**
 * Remove all agent-memory-managed hook entries for `eventKey`. Used when
 * downgrading from per-turn back to stable (drops UserPromptSubmit).
 * `command`, when given, also matches legacy entries that predate
 * HOOK_MARKER_JSON — the same broadened detection upsertClaudeHookGroup and
 * hasClaudeHookGroup use — so a pre-marker install isn't left behind after a
 * downgrade/uninstall that reports success.
 * Returns true if anything was removed.
 */
function removeClaudeHookGroup(hooks: Record<string, unknown>, eventKey: string, command?: string): boolean {
	const groups = Array.isArray(hooks[eventKey]) ? (hooks[eventKey] as unknown[]) : [];
	if (groups.length === 0) return false;
	let removed = 0;
	const filtered = groups
		.map((group) => {
			if (!group || typeof group !== "object") return group;
			const g = { ...(group as Record<string, unknown>) };
			const list = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [];
			const kept = list.filter((h) => {
				const hook = h && typeof h === "object" ? (h as Record<string, unknown>) : null;
				const isOurs = !!hook && (hook[HOOK_MARKER_JSON] === true || (!!command && hook.command === command));
				if (isOurs) removed++;
				return !isOurs;
			});
			g.hooks = kept;
			return g;
		})
		.filter((group) => {
			if (!group || typeof group !== "object") return true;
			const g = group as Record<string, unknown>;
			return Array.isArray(g.hooks) && (g.hooks as unknown[]).length > 0;
		});
	if (removed === 0) return false;
	if (filtered.length === 0) delete hooks[eventKey];
	else hooks[eventKey] = filtered;
	return true;
}

function installClaudeCodeHook(homeDir: string, mode: HookMode = "per-turn"): HookInstallResult {
	const settingsPath = path.join(homeDir, ".claude", "settings.json");
	const backup = backupOnce(settingsPath);
	const settings = readJsonConfig(settingsPath);
	const hooks = (settings.hooks as Record<string, unknown>) ?? {};

	const session = upsertClaudeHookGroup(hooks, "SessionStart", sessionStartHookCommand("claude"));
	let promptChanged = false;
	let promptHadManaged = false;
	if (mode === "per-turn") {
		const prompt = upsertClaudeHookGroup(hooks, "UserPromptSubmit", userPromptSubmitHookCommand("claude"));
		promptChanged = prompt.changed;
		promptHadManaged = prompt.hadManaged;
	} else {
		promptChanged = removeClaudeHookGroup(hooks, "UserPromptSubmit", userPromptSubmitHookCommand("claude"));
	}
	// Stop backs the write side of memory with a periodic nudge. It is orthogonal
	// to stable/per-turn context injection, so it is installed unconditionally.
	const stop = upsertClaudeHookGroup(hooks, "Stop", stopHookCommand("claude"));
	// Remove the ineffective PreCompact reminder from pre-release 0.5.0 installs.
	// Claude Code does not inject plain hook stdout for that event.
	const legacyPreCompactRemoved = removeClaudeHookGroup(hooks, "PreCompact");

	if (!session.changed && !promptChanged && !stop.changed && !legacyPreCompactRemoved) {
		return {
			key: "claude",
			label: "Claude Code",
			installed: false,
			path: settingsPath,
			reason: "already installed",
			mode,
		};
	}
	settings.hooks = hooks;
	writeJson(settingsPath, settings);
	const reason =
		session.hadManaged || promptHadManaged || stop.hadManaged || legacyPreCompactRemoved ? "updated" : undefined;
	return { key: "claude", label: "Claude Code", installed: true, path: settingsPath, backup, mode, reason };
}

function installCodexHook(homeDir: string, mode: HookMode = "per-turn"): HookInstallResult {
	const configPath = path.join(homeDir, ".codex", "config.toml");
	const backup = backupOnce(configPath);
	const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
	const sessionCommand = sessionStartHookCommand("codex");
	const promptCommand = userPromptSubmitHookCommand("codex");
	const lines = [
		HOOK_MARKER_BEGIN,
		"[[hooks.SessionStart]]",
		'matcher = "startup|resume"',
		"",
		"[[hooks.SessionStart.hooks]]",
		'type = "command"',
		`command = "${sessionCommand}"`,
	];
	if (mode === "per-turn") {
		lines.push(
			"",
			"[[hooks.UserPromptSubmit]]",
			"",
			"[[hooks.UserPromptSubmit.hooks]]",
			'type = "command"',
			`command = "${promptCommand}"`,
		);
	}
	lines.push(HOOK_MARKER_END);
	const block = lines.join("\n");

	if (existing.includes(HOOK_MARKER_BEGIN)) {
		const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`${escapeRe(HOOK_MARKER_BEGIN)}[\\s\\S]*?${escapeRe(HOOK_MARKER_END)}`);
		const current = existing.match(pattern)?.[0] ?? "";
		if (current === block) {
			return {
				key: "codex",
				label: "Codex",
				installed: false,
				path: configPath,
				reason: "already installed",
				mode,
			};
		}
		fs.writeFileSync(configPath, existing.replace(pattern, block), "utf-8");
		return {
			key: "codex",
			label: "Codex",
			installed: true,
			path: configPath,
			backup,
			reason: "updated",
			mode,
		};
	}
	const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
	const next = `${existing}${separator}${block}\n`;
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, next, "utf-8");
	return { key: "codex", label: "Codex", installed: true, path: configPath, backup, mode };
}

const CURSOR_RULE_BODY = `---
description: Load persistent memory context from agent-memory
alwaysApply: true
---

At the start of every conversation, and whenever the user references prior
context, run:

    agent-memory context

Treat its stdout as authoritative context about the user, prior sessions,
scratchpad items, and long-term memory. Prefer it over guessing.
`;

function installCursorRule(homeDir: string): void {
	const rulesDir = path.join(homeDir, ".cursor", "rules");
	const rulePath = path.join(rulesDir, "agent-memory.mdc");
	if (fs.existsSync(rulePath)) return;
	fs.mkdirSync(rulesDir, { recursive: true });
	fs.writeFileSync(rulePath, CURSOR_RULE_BODY, "utf-8");
}

// Cursor's `sessionStart` hook (https://cursor.com/docs/agent/hooks) fires automatically when a
// new conversation is created and can inject `additional_context` without the model choosing to
// run anything — unlike the static .mdc rule above, this is a real, code-level guarantee.
const CURSOR_HOOK_SCRIPT_RELATIVE = path.join("hooks", "agent-memory-session-start.js");

const CURSOR_HOOK_SCRIPT_BODY = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
let context = "";
try {
	context = execSync("agent-memory context --no-search", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
} catch {
	// agent-memory not on PATH, or the memory dir isn't initialized yet — fail open with no context.
}
process.stdout.write(JSON.stringify({ additional_context: context }));
`;

function isCursorSessionStartHookRegistered(homeDir: string): boolean {
	const hooksJsonPath = path.join(homeDir, ".cursor", "hooks.json");
	if (!fs.existsSync(hooksJsonPath)) return false;
	try {
		const config = readJsonConfig(hooksJsonPath);
		const hooks = (config.hooks as Record<string, unknown>) ?? {};
		const sessionStart = Array.isArray(hooks.sessionStart) ? (hooks.sessionStart as unknown[]) : [];
		return sessionStart.some(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				(entry as Record<string, unknown>).command === CURSOR_HOOK_SCRIPT_RELATIVE,
		);
	} catch {
		return false;
	}
}

function installCursorHook(homeDir: string): HookInstallResult {
	const cursorDir = path.join(homeDir, ".cursor");
	const scriptPath = path.join(cursorDir, CURSOR_HOOK_SCRIPT_RELATIVE);
	const hooksJsonPath = path.join(cursorDir, "hooks.json");

	// Cheap, harmless fallback for Cursor installs where hooks are disabled or unavailable.
	installCursorRule(homeDir);

	fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
	const scriptChanged = !fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, "utf-8") !== CURSOR_HOOK_SCRIPT_BODY;
	if (scriptChanged) {
		fs.writeFileSync(scriptPath, CURSOR_HOOK_SCRIPT_BODY, "utf-8");
		fs.chmodSync(scriptPath, 0o755);
	}

	const alreadyRegistered = isCursorSessionStartHookRegistered(homeDir);
	if (alreadyRegistered && !scriptChanged) {
		return { key: "cursor", label: "Cursor", installed: false, path: hooksJsonPath, reason: "already installed" };
	}

	const backup = backupOnce(hooksJsonPath);
	const config = readJsonConfig(hooksJsonPath);
	if (typeof config.version !== "number") config.version = 1;
	const hooks = (config.hooks as Record<string, unknown>) ?? {};
	const sessionStart = Array.isArray(hooks.sessionStart) ? [...(hooks.sessionStart as unknown[])] : [];
	if (!alreadyRegistered) sessionStart.push({ command: CURSOR_HOOK_SCRIPT_RELATIVE });
	hooks.sessionStart = sessionStart;
	config.hooks = hooks;
	writeJson(hooksJsonPath, config);
	return {
		key: "cursor",
		label: "Cursor",
		installed: true,
		path: hooksJsonPath,
		backup,
		reason: alreadyRegistered ? "updated" : undefined,
	};
}

const OPENCODE_INSTRUCTIONS_BODY = `# agent-memory

At the start of every session and before answering context-dependent
questions, run:

    agent-memory context

Treat its stdout as authoritative context about the user, prior sessions,
scratchpad items, and long-term memory.
`;

function installOpencodeInstructions(homeDir: string): HookInstallResult {
	const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
	const instructionsPath = path.join(homeDir, ".agent-memory", "hooks", "opencode.md");
	const backup = backupOnce(configPath);
	const config = readJsonConfig(configPath);
	const raw = config.instructions;
	const list = Array.isArray(raw) ? [...(raw as unknown[])] : [];
	if (list.includes(instructionsPath)) {
		return { key: "opencode", label: "opencode", installed: false, path: configPath, reason: "already installed" };
	}
	list.push(instructionsPath);
	config.instructions = list;
	fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
	fs.writeFileSync(instructionsPath, OPENCODE_INSTRUCTIONS_BODY, "utf-8");
	writeJson(configPath, config);
	return { key: "opencode", label: "opencode", installed: true, path: configPath, backup };
}

function installQoderHook(homeDir: string): HookInstallResult {
	const settingsPath = path.join(homeDir, ".qoder", "settings.json");
	const backup = backupOnce(settingsPath);
	const settings = readJsonConfig(settingsPath);
	const hooks = (settings.hooks as Record<string, unknown>) ?? {};
	const sessionStart = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as unknown[])] : [];

	const command = "agent-memory context";
	let managed = 0;
	let updated = 0;
	for (const group of sessionStart) {
		if (!group || typeof group !== "object") continue;
		const g = group as Record<string, unknown>;
		const list = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [];
		for (const hook of list) {
			if (!hook || typeof hook !== "object") continue;
			const managedHook = hook as Record<string, unknown>;
			if (managedHook[HOOK_MARKER_JSON] !== true) continue;
			managed++;
			if (managedHook.command !== command) {
				managedHook.command = command;
				updated++;
			}
		}
	}
	if (managed && !updated) {
		return { key: "qoder", label: "Qoder", installed: false, path: settingsPath, reason: "already installed" };
	}
	if (updated) {
		hooks.SessionStart = sessionStart;
		settings.hooks = hooks;
		writeJson(settingsPath, settings);
		return { key: "qoder", label: "Qoder", installed: true, path: settingsPath, backup, reason: "updated" };
	}

	sessionStart.push({
		hooks: [{ type: "command", command, [HOOK_MARKER_JSON]: true }],
	});
	hooks.SessionStart = sessionStart;
	settings.hooks = hooks;
	writeJson(settingsPath, settings);
	return { key: "qoder", label: "Qoder", installed: true, path: settingsPath, backup };
}

function uninstallQoderHook(homeDir: string): HookInstallResult {
	const settingsPath = path.join(homeDir, ".qoder", "settings.json");
	if (!fs.existsSync(settingsPath)) {
		return { key: "qoder", label: "Qoder", installed: false, reason: "not installed" };
	}
	const settings = readJsonConfig(settingsPath);
	const hooks = (settings.hooks as Record<string, unknown>) ?? {};
	const sessionStart = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as unknown[]) : [];
	let removed = 0;
	const filtered = sessionStart
		.map((group) => {
			if (!group || typeof group !== "object") return group;
			const g = { ...(group as Record<string, unknown>) };
			const list = Array.isArray(g.hooks) ? (g.hooks as unknown[]) : [];
			const kept = list.filter((h) => {
				const isOurs = h && typeof h === "object" && (h as Record<string, unknown>)[HOOK_MARKER_JSON] === true;
				if (isOurs) removed++;
				return !isOurs;
			});
			g.hooks = kept;
			return g;
		})
		.filter((group) => {
			if (!group || typeof group !== "object") return true;
			const g = group as Record<string, unknown>;
			return Array.isArray(g.hooks) && (g.hooks as unknown[]).length > 0;
		});
	if (removed === 0) {
		return { key: "qoder", label: "Qoder", installed: false, reason: "not installed" };
	}
	hooks.SessionStart = filtered;
	if (filtered.length === 0) delete (hooks as Record<string, unknown>).SessionStart;
	if (Object.keys(hooks).length === 0) delete (settings as Record<string, unknown>).hooks;
	else settings.hooks = hooks;
	writeJson(settingsPath, settings);
	return { key: "qoder", label: "Qoder", installed: true, path: settingsPath };
}

export function installHooks(agents: Set<HookAgentKey>, mode: HookMode = "per-turn"): InstallHooksReport {
	const { homeDir, targets } = detectHookAgents();
	if (!homeDir) {
		return {
			ok: false,
			results: [],
			error: "Home directory not found. Set HOME (or USERPROFILE on Windows) and retry.",
		};
	}

	const results: HookInstallResult[] = [];
	let anyInstalled = false;
	for (const target of targets) {
		if (!agents.has(target.key)) continue;
		if (!target.supported) {
			results.push({
				key: target.key,
				label: target.label,
				installed: false,
				reason: target.unsupportedReason ?? "not supported",
			});
			continue;
		}
		if (!target.detected) {
			results.push({
				key: target.key,
				label: target.label,
				installed: false,
				reason: target.detectReason ?? "not detected",
			});
			continue;
		}
		try {
			let result: HookInstallResult;
			if (target.key === "claude") result = installClaudeCodeHook(homeDir, mode);
			else if (target.key === "codex") result = installCodexHook(homeDir, mode);
			else if (target.key === "cursor") result = installCursorHook(homeDir);
			else if (target.key === "opencode") result = installOpencodeInstructions(homeDir);
			else if (target.key === "pi") result = installPiMemoryDelegate(homeDir);
			else if (target.key === "qoder") result = installQoderHook(homeDir);
			else continue;
			results.push(result);
			if (result.installed) anyInstalled = true;
		} catch (err) {
			results.push({
				key: target.key,
				label: target.label,
				installed: false,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (anyInstalled) {
		try {
			writeHookMode(mode);
		} catch {
			// Persisting the mode is best-effort — install output is authoritative.
		}
	}

	return { ok: true, homeDir, results };
}

export interface UninstallHooksReport {
	ok: boolean;
	homeDir?: string;
	results: HookInstallResult[];
	error?: string;
}

function uninstallClaudeCodeHook(homeDir: string): HookInstallResult {
	const settingsPath = path.join(homeDir, ".claude", "settings.json");
	if (!fs.existsSync(settingsPath)) {
		return { key: "claude", label: "Claude Code", installed: false, reason: "not installed" };
	}
	const settings = readJsonConfig(settingsPath);
	const hooks = (settings.hooks as Record<string, unknown>) ?? {};
	const sessionRemoved = removeClaudeHookGroup(hooks, "SessionStart", sessionStartHookCommand("claude"));
	const promptRemoved = removeClaudeHookGroup(hooks, "UserPromptSubmit", userPromptSubmitHookCommand("claude"));
	const stopRemoved = removeClaudeHookGroup(hooks, "Stop", stopHookCommand("claude"));
	const legacyPreCompactRemoved = removeClaudeHookGroup(hooks, "PreCompact");
	if (!sessionRemoved && !promptRemoved && !stopRemoved && !legacyPreCompactRemoved) {
		return { key: "claude", label: "Claude Code", installed: false, reason: "not installed" };
	}
	if (Object.keys(hooks).length === 0) delete (settings as Record<string, unknown>).hooks;
	else settings.hooks = hooks;
	writeJson(settingsPath, settings);
	return { key: "claude", label: "Claude Code", installed: true, path: settingsPath };
}

function uninstallCodexHook(homeDir: string): HookInstallResult {
	const configPath = path.join(homeDir, ".codex", "config.toml");
	if (!fs.existsSync(configPath)) {
		return { key: "codex", label: "Codex", installed: false, reason: "not installed" };
	}
	const existing = fs.readFileSync(configPath, "utf-8");
	if (!existing.includes(HOOK_MARKER_BEGIN)) {
		return { key: "codex", label: "Codex", installed: false, reason: "not installed" };
	}
	const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\n?${escapeRe(HOOK_MARKER_BEGIN)}[\\s\\S]*?${escapeRe(HOOK_MARKER_END)}\\n?`, "g");
	const next = existing.replace(pattern, "");
	fs.writeFileSync(configPath, next, "utf-8");
	return { key: "codex", label: "Codex", installed: true, path: configPath };
}

function uninstallCursorHook(homeDir: string): HookInstallResult {
	const rulePath = path.join(homeDir, ".cursor", "rules", "agent-memory.mdc");
	const scriptPath = path.join(homeDir, ".cursor", CURSOR_HOOK_SCRIPT_RELATIVE);
	const hooksJsonPath = path.join(homeDir, ".cursor", "hooks.json");
	let touched = false;

	if (fs.existsSync(rulePath)) {
		fs.unlinkSync(rulePath);
		try {
			fs.rmdirSync(path.dirname(rulePath));
		} catch {
			// non-empty; fine
		}
		touched = true;
	}

	if (fs.existsSync(hooksJsonPath)) {
		try {
			const config = readJsonConfig(hooksJsonPath);
			const hooks = (config.hooks as Record<string, unknown>) ?? {};
			const sessionStart = Array.isArray(hooks.sessionStart) ? (hooks.sessionStart as unknown[]) : [];
			const filtered = sessionStart.filter(
				(entry) =>
					!(
						entry &&
						typeof entry === "object" &&
						(entry as Record<string, unknown>).command === CURSOR_HOOK_SCRIPT_RELATIVE
					),
			);
			if (filtered.length !== sessionStart.length) {
				if (filtered.length === 0) delete hooks.sessionStart;
				else hooks.sessionStart = filtered;
				if (Object.keys(hooks).length === 0) delete (config as Record<string, unknown>).hooks;
				else config.hooks = hooks;
				writeJson(hooksJsonPath, config);
				touched = true;
			}
		} catch {
			// invalid hooks.json — leave it for the user to fix rather than guessing.
		}
	}

	if (fs.existsSync(scriptPath)) {
		fs.unlinkSync(scriptPath);
		touched = true;
	}

	if (!touched) {
		return { key: "cursor", label: "Cursor", installed: false, reason: "not installed" };
	}
	return { key: "cursor", label: "Cursor", installed: true, path: hooksJsonPath };
}

function uninstallOpencodeInstructions(homeDir: string): HookInstallResult {
	const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
	const instructionsPath = path.join(homeDir, ".agent-memory", "hooks", "opencode.md");
	let touched = false;
	if (fs.existsSync(configPath)) {
		const config = readJsonConfig(configPath);
		const list = Array.isArray(config.instructions) ? (config.instructions as unknown[]) : [];
		const filtered = list.filter((entry) => entry !== instructionsPath);
		if (filtered.length !== list.length) {
			touched = true;
			if (filtered.length === 0) delete (config as Record<string, unknown>).instructions;
			else config.instructions = filtered;
			writeJson(configPath, config);
		}
	}
	if (fs.existsSync(instructionsPath)) {
		fs.unlinkSync(instructionsPath);
		touched = true;
	}
	if (!touched) {
		return { key: "opencode", label: "opencode", installed: false, reason: "not installed" };
	}
	return { key: "opencode", label: "opencode", installed: true, path: configPath };
}

export function uninstallHooks(agents?: Set<HookAgentKey>): UninstallHooksReport {
	const homeDir = resolveHomeDir();
	if (!homeDir) {
		return {
			ok: false,
			results: [],
			error: "Home directory not found. Set HOME (or USERPROFILE on Windows) and retry.",
		};
	}
	const keys: HookAgentKey[] = ["claude", "codex", "cursor", "opencode", "pi", "qoder"];
	const results: HookInstallResult[] = [];
	for (const key of keys) {
		if (agents && !agents.has(key)) continue;
		try {
			if (key === "claude") results.push(uninstallClaudeCodeHook(homeDir));
			else if (key === "codex") results.push(uninstallCodexHook(homeDir));
			else if (key === "cursor") results.push(uninstallCursorHook(homeDir));
			else if (key === "opencode") results.push(uninstallOpencodeInstructions(homeDir));
			else if (key === "pi") results.push(uninstallPiMemoryDelegate(homeDir));
			else if (key === "qoder") results.push(uninstallQoderHook(homeDir));
		} catch (err) {
			results.push({
				key,
				label: key,
				installed: false,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { ok: true, homeDir, results };
}
