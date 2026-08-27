import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
			label: "pi",
			homeMarker: path.join(homeDir, ".pi"),
			detectFiles: [path.join(homeDir, ".pi", "extensions")],
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

function installClaudeCodeHook(homeDir: string): HookInstallResult {
	const settingsPath = path.join(homeDir, ".claude", "settings.json");
	const backup = backupOnce(settingsPath);
	const settings = readJsonConfig(settingsPath);
	const hooks = (settings.hooks as Record<string, unknown>) ?? {};
	const sessionStart = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as unknown[])] : [];

	// Idempotency: look for any existing entry tagged with our marker.
	const command = sessionStartHookCommand("claude");
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
		return { key: "claude", label: "Claude Code", installed: false, path: settingsPath, reason: "already installed" };
	}
	if (updated) {
		hooks.SessionStart = sessionStart;
		settings.hooks = hooks;
		writeJson(settingsPath, settings);
		return { key: "claude", label: "Claude Code", installed: true, path: settingsPath, backup, reason: "updated" };
	}

	sessionStart.push({
		matcher: "startup|resume",
		hooks: [{ type: "command", command, [HOOK_MARKER_JSON]: true }],
	});
	hooks.SessionStart = sessionStart;
	settings.hooks = hooks;
	writeJson(settingsPath, settings);
	return { key: "claude", label: "Claude Code", installed: true, path: settingsPath, backup };
}

function installCodexHook(homeDir: string): HookInstallResult {
	const configPath = path.join(homeDir, ".codex", "config.toml");
	const backup = backupOnce(configPath);
	const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
	const command = sessionStartHookCommand("codex");
	const block = [
		HOOK_MARKER_BEGIN,
		"[[hooks.SessionStart]]",
		'matcher = "startup|resume"',
		"",
		"[[hooks.SessionStart.hooks]]",
		'type = "command"',
		`command = "${command}"`,
		HOOK_MARKER_END,
	].join("\n");
	if (existing.includes(HOOK_MARKER_BEGIN)) {
		const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`${escapeRe(HOOK_MARKER_BEGIN)}[\\s\\S]*?${escapeRe(HOOK_MARKER_END)}`);
		const current = existing.match(pattern)?.[0] ?? "";
		if (current.includes(`command = "${command}"`)) {
			return { key: "codex", label: "Codex", installed: false, path: configPath, reason: "already installed" };
		}
		fs.writeFileSync(configPath, existing.replace(pattern, block), "utf-8");
		return { key: "codex", label: "Codex", installed: true, path: configPath, backup, reason: "updated" };
	}
	const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
	const next = `${existing}${separator}${block}\n`;
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, next, "utf-8");
	return { key: "codex", label: "Codex", installed: true, path: configPath, backup };
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

function installCursorRule(homeDir: string): HookInstallResult {
	const rulesDir = path.join(homeDir, ".cursor", "rules");
	const rulePath = path.join(rulesDir, "agent-memory.mdc");
	if (fs.existsSync(rulePath)) {
		return { key: "cursor", label: "Cursor", installed: false, path: rulePath, reason: "already installed" };
	}
	fs.mkdirSync(rulesDir, { recursive: true });
	fs.writeFileSync(rulePath, CURSOR_RULE_BODY, "utf-8");
	return { key: "cursor", label: "Cursor", installed: true, path: rulePath };
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

const PI_EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * AgentMemory extension for Pi Coding Agent.
 *
 * Subscribes to session_start and runs \`agent-memory context\` to inject
 * persistent memory at the start of every session.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const result = await pi.exec("agent-memory", ["context"], {
        timeout: 10000,
      });
      if (result.stdout?.trim()) {
        ctx.ui.notify(
          \`Memory loaded: \${result.stdout.split("\\n").length} lines\`,
          "info",
        );
      }
    } catch {
      // agent-memory not installed or not on PATH — skip silently
    }
  });
}`;

function installPiExtension(homeDir: string): HookInstallResult {
	const extDir = path.join(homeDir, ".pi", "extensions");
	const destPath = path.join(extDir, "agent-memory.ts");
	if (fs.existsSync(destPath)) {
		return { key: "pi", label: "pi", installed: false, path: destPath, reason: "already installed" };
	}
	fs.mkdirSync(extDir, { recursive: true });
	fs.writeFileSync(destPath, PI_EXTENSION_SOURCE, "utf-8");
	return { key: "pi", label: "pi", installed: true, path: destPath };
}

function uninstallPiExtension(homeDir: string): HookInstallResult {
	const destPath = path.join(homeDir, ".pi", "extensions", "agent-memory.ts");
	if (!fs.existsSync(destPath)) {
		return { key: "pi", label: "pi", installed: false, reason: "not installed" };
	}
	fs.unlinkSync(destPath);
	return { key: "pi", label: "pi", installed: true, path: destPath };
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

export function installHooks(agents: Set<HookAgentKey>): InstallHooksReport {
	const { homeDir, targets } = detectHookAgents();
	if (!homeDir) {
		return {
			ok: false,
			results: [],
			error: "Home directory not found. Set HOME (or USERPROFILE on Windows) and retry.",
		};
	}

	const results: HookInstallResult[] = [];
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
			if (target.key === "claude") results.push(installClaudeCodeHook(homeDir));
			else if (target.key === "codex") results.push(installCodexHook(homeDir));
			else if (target.key === "cursor") results.push(installCursorRule(homeDir));
			else if (target.key === "opencode") results.push(installOpencodeInstructions(homeDir));
			else if (target.key === "qoder") results.push(installQoderHook(homeDir));
			else if (target.key === "pi") results.push(installPiExtension(homeDir));
		} catch (err) {
			results.push({
				key: target.key,
				label: target.label,
				installed: false,
				reason: err instanceof Error ? err.message : String(err),
			});
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
		return { key: "claude", label: "Claude Code", installed: false, reason: "not installed" };
	}
	hooks.SessionStart = filtered;
	if (filtered.length === 0) delete (hooks as Record<string, unknown>).SessionStart;
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

function uninstallCursorRule(homeDir: string): HookInstallResult {
	const rulePath = path.join(homeDir, ".cursor", "rules", "agent-memory.mdc");
	if (!fs.existsSync(rulePath)) {
		return { key: "cursor", label: "Cursor", installed: false, reason: "not installed" };
	}
	fs.unlinkSync(rulePath);
	try {
		fs.rmdirSync(path.dirname(rulePath));
	} catch {
		// non-empty; fine
	}
	return { key: "cursor", label: "Cursor", installed: true, path: rulePath };
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
	const keys: HookAgentKey[] = ["claude", "codex", "cursor", "opencode", "qoder", "pi"];
	const results: HookInstallResult[] = [];
	for (const key of keys) {
		if (agents && !agents.has(key)) continue;
		try {
			if (key === "claude") results.push(uninstallClaudeCodeHook(homeDir));
			else if (key === "codex") results.push(uninstallCodexHook(homeDir));
			else if (key === "cursor") results.push(uninstallCursorRule(homeDir));
			else if (key === "opencode") results.push(uninstallOpencodeInstructions(homeDir));
			else if (key === "qoder") results.push(uninstallQoderHook(homeDir));
			else if (key === "pi") results.push(uninstallPiExtension(homeDir));
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
