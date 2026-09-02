#!/usr/bin/env node
/**
 * agent-memory CLI
 *
 * Subcommands:
 *   version    — Print binary version
 *   install-skills — Install (or --uninstall) SKILL.md files into local agent directories
 *   context    — Build & print context injection string to stdout
 *   write      — Write to memory files
 *   read       — Read memory files
 *   scratchpad — Manage checklist
 *   search     — Search via qmd
 *   init       — Create dirs, detect qmd, setup collection
 *   status     — Show config, qmd status, file counts
 *   completion — Install or print shell completion
 *   install-hooks — Install managed session-start hooks
 *   uninstall-hooks — Remove managed session-start hooks
 *   plugin     — Discover and bootstrap optional official plugins
 *
 * Global flags:
 *   --dir <path>   Override memory directory
 *   --json         Machine-readable JSON output
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	COMMAND_DESCRIPTIONS,
	COMMAND_OPTIONS,
	COMMANDS,
	GLOBAL_OPTIONS,
	optionTakesValue,
	PLUGIN_COMMAND_OPTIONS,
	renderCommandHelp,
	SCRATCHPAD_ACTION_OPTIONS,
} from "./cli-spec.js";
import {
	type CompletionShell,
	detectCompletionShell,
	generateCompletion,
	installCompletion,
	uninstallCompletion,
} from "./completions.js";

import {
	_setBaseDir,
	buildDynamicContext,
	buildMemoryContext,
	buildStableContext,
	checkCollection,
	dailyPath,
	detectQmd,
	distilMemories,
	ensureDirs,
	ensureQmdAvailableForSync,
	ensureQmdAvailableForUpdate,
	getCollectionName,
	getDailyDir,
	getMemoryDir,
	getMemoryFile,
	getQmdEmbedMode,
	getQmdHealth,
	getQmdResultPath,
	getQmdResultText,
	getScratchpadFile,
	getTopicsDir,
	type HookMode,
	installSkills,
	memoryWrite,
	nowTimestamp,
	parseScratchpad,
	probeEmbeddings,
	readFileSafe,
	readHookMode,
	redactSecrets,
	runQmdEmbedDetached,
	runQmdSearch,
	runQmdSync,
	runQmdUpdateNow,
	scheduleQmdUpdate,
	scratchpadAction,
	searchRelevantMemories,
	serializeScratchpad,
	setupQmdCollection,
	slugifyTopic,
	todayStr,
	topicPath,
	uninstallSkills,
} from "./core.js";
import {
	detectHookAgents,
	type HookAgentKey,
	installHooks,
	isHookInstalled,
	isStopHookInstalled,
	isUserPromptSubmitInstalled,
	uninstallHooks,
} from "./hooks.js";
import { StdioMcpServer } from "./mcp-server.js";
import {
	createDefaultPluginBootstrap,
	getDefaultPluginInstallRoot,
	PluginBootstrapFailure,
	type PluginBootstrapResultV1,
} from "./plugin-bootstrap.js";
import type { PluginContextSectionV1 } from "./plugin-host.js";
import { InstalledPluginRuntimeV1 } from "./plugin-runtime.js";
import {
	checkForUpgrades,
	detectInstallMethod,
	formatUpgradeNotice,
	isCacheFresh,
	readUpgradeCache,
	refreshUpgradeCacheBackground,
	runInstaller,
	type UpgradeStatus,
} from "./upgrade.js";

declare const __VERSION__: string;

function readPackageVersion(): string {
	try {
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
			version?: unknown;
		};
		return typeof packageJson.version === "string" ? packageJson.version : "dev";
	} catch {
		return "dev";
	}
}

const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : readPackageVersion();

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

	// Normalize short flags to their long form so downstream code can rely on `flags.help`
	// / `flags.version` without also checking `-h` / `-V`. Reserved shorthands only.
	const SHORT_TO_LONG: Record<string, string> = { "-h": "--help", "-V": "--version" };
	const normalized = argv.map((arg) => SHORT_TO_LONG[arg] ?? arg);

	for (let i = 0; i < normalized.length; i++) {
		const arg = normalized[i];

		if (!command && !arg.startsWith("-")) {
			command = arg;
			continue;
		}

		if (arg.startsWith("--")) {
			// Support `--flag=value` in addition to `--flag value`.
			const eqIdx = arg.indexOf("=");
			if (eqIdx > 2) {
				flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
				continue;
			}
			const key = arg.slice(2);
			const next = normalized[i + 1];
			// Use the option spec to decide whether this flag takes a value; that way boolean
			// flags don't greedily consume the next positional argument. Unknown flags fall
			// back to the "next token isn't a flag" heuristic.
			const known = optionTakesValue(`--${key}`);
			const looksLikeValue = next !== undefined && !next.startsWith("-");
			if (known === true && looksLikeValue) {
				flags[key] = next;
				i++;
			} else if (known === false) {
				flags[key] = true;
			} else if (looksLikeValue) {
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
// Fuzzy suggestions (levenshtein distance)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const prev = new Array(b.length + 1);
	const curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
	}
	return prev[b.length];
}

// ---------------------------------------------------------------------------
// Pro plan / cap-exhausted UX
// ---------------------------------------------------------------------------

const UPGRADE_URL = "https://agentmemory.paperpilot.me/upgrade";

interface CapExhaustedResult {
	code?: string;
	message?: string;
	resetAt?: string;
	used?: number;
	limit?: number;
	remaining?: number;
}

function detectCapExhausted(result: {
	ok?: boolean;
	error?: { code?: string; message?: string };
	data?: unknown;
}): CapExhaustedResult | null {
	if (result.ok !== false) return null;
	const code = result.error?.code ?? "";
	const message = result.error?.message ?? "";

	// Authoritative signal: the plugin passed a decision through the data channel.
	let decisionExhausted = false;
	let resetAt: string | undefined;
	let used: number | undefined;
	let limit: number | undefined;
	let remaining: number | undefined;
	if (result.data && typeof result.data === "object") {
		const decision = (result.data as { decision?: Record<string, unknown> }).decision;
		if (decision) {
			decisionExhausted = decision.state === "exhausted";
			if (typeof decision.resetAt === "string") resetAt = decision.resetAt;
			if (typeof decision.used === "number") used = decision.used;
			if (typeof decision.limit === "number") limit = decision.limit;
			if (typeof decision.remaining === "number") remaining = decision.remaining;
		}
	}

	// Only treat semantic exhaustion codes as cap-hits. Transient throttles
	// (rate_limit, too_many_requests, HTTP 429) are NOT exhaustion — they must
	// bubble as normal errors so we don't mislead the user with an upgrade prompt.
	const hardExhaustion =
		/^(session_exhausted|quota_exceeded|preview_(limit|exhausted)|allowance_exhausted|session_capacity)$/i.test(code);
	const messageExhaustion = /free preview (limit|allowance)|daily limit reached|no recalls remaining/i.test(message);

	if (!decisionExhausted && !hardExhaustion && !messageExhaustion) return null;

	// Fallback: look for an ISO-ish timestamp in the message.
	if (!resetAt) {
		const match = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/.exec(message);
		if (match) resetAt = match[1];
	}
	return { code, message, resetAt, used, limit, remaining };
}

function formatResetTime(resetAt: string | undefined): string {
	if (!resetAt) return "later today";
	const parsed = Date.parse(resetAt);
	if (!Number.isFinite(parsed)) return resetAt;
	const now = Date.now();
	const diffMs = parsed - now;
	if (diffMs <= 0) return "now";
	const hours = Math.floor(diffMs / 3_600_000);
	const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function printCapExhaustedBox(command: string, info: CapExhaustedResult): void {
	const reset = formatResetTime(info.resetAt);
	const usedLine =
		info.used !== undefined && info.limit !== undefined
			? `  You've used all ${info.used}/${info.limit} free '${command}' calls today (resets in ${reset}).`
			: `  '${command}' free preview limit hit (resets in ${reset}).`;
	const lines = [
		"",
		"─────────────────────────────────────────────────────────────",
		usedLine,
		"",
		"  Upgrade for unlimited recall + automatic capture:",
		`    ${UPGRADE_URL}`,
		"─────────────────────────────────────────────────────────────",
		"",
	];
	console.error(lines.join("\n"));
	openExternalUrl(UPGRADE_URL);
}

// Persist the last usage decision to disk so `pro status` can show counters.
function cacheProUsage(decision: {
	used?: number;
	limit?: number;
	remaining?: number;
	resetAt?: string;
	state?: string;
	capability?: string;
}): void {
	try {
		const stateDir = `${getMemoryDir()}/state`;
		fs.mkdirSync(stateDir, { recursive: true });
		const path = `${stateDir}/pro-usage.json`;
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(fs.readFileSync(path, "utf-8"));
		} catch {
			// missing or corrupt — start fresh
		}
		const capability = decision.capability ?? "session";
		existing[capability] = {
			used: decision.used,
			limit: decision.limit,
			remaining: decision.remaining,
			resetAt: decision.resetAt,
			state: decision.state,
			recordedAt: new Date().toISOString(),
		};
		fs.writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// caching is best-effort
	}
}

function nearest(word: string, candidates: Iterable<string>, maxDistance = 2): string | undefined {
	let best: { word: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = levenshtein(word, candidate);
		if (distance <= maxDistance && (!best || distance < best.distance)) {
			best = { word: candidate, distance };
		}
	}
	return best?.word;
}

// ---------------------------------------------------------------------------
// Argument validation (whitelist from cli-spec)
// ---------------------------------------------------------------------------

// Internal / non-user commands that opt out of strict flag validation.
// `hook` is invoked by SessionStart wrappers with dynamic keys.
const UNVALIDATED_COMMANDS = new Set(["hook"]);

function allowedFlagsFor(command: string, positional: string[]): Set<string> {
	// `distill` (double-l) is an accepted alias for `distil` — share its flag whitelist.
	const canonical = command === "distill" ? "distil" : command;
	const allowed = new Set<string>();
	for (const opt of GLOBAL_OPTIONS) allowed.add(opt.replace(/^-+/, ""));
	for (const opt of COMMAND_OPTIONS[canonical] ?? []) allowed.add(opt.replace(/^-+/, ""));

	const sub = positional[0];
	if (sub) {
		if (canonical === "scratchpad") {
			for (const opt of SCRATCHPAD_ACTION_OPTIONS[sub] ?? []) allowed.add(opt.replace(/^-+/, ""));
		}
		if (canonical === "plugin" || canonical === "pro") {
			const key = sub === "upgrade" ? "update" : sub;
			for (const opt of PLUGIN_COMMAND_OPTIONS[key] ?? []) allowed.add(opt.replace(/^-+/, ""));
		}
	}
	return allowed;
}

function validateCommand(command: string): void {
	if (!command || UNVALIDATED_COMMANDS.has(command)) return;
	const known = new Set<string>([...COMMANDS, "distill", "hook"]);
	if (known.has(command)) return;
	// Unknown commands may still be plugin-provided; only warn when clearly a typo of a core command.
	const suggestion = nearest(command, COMMANDS);
	if (suggestion) {
		console.error(`Error: Unknown command '${command}'. Did you mean '${suggestion}'?`);
		console.error("Run 'agent-memory help' for the full list.");
		process.exit(1);
	}
	// Fall through — plugin runtime will produce a definitive error if the command is truly unknown.
}

function validateFlags(command: string, positional: string[], flags: Record<string, string | boolean>): void {
	if (!command || UNVALIDATED_COMMANDS.has(command)) return;
	if (!COMMANDS.includes(command as (typeof COMMANDS)[number]) && command !== "distill") return; // plugin commands validate their own flags
	const allowed = allowedFlagsFor(command, positional);
	for (const key of Object.keys(flags)) {
		if (allowed.has(key)) continue;
		const suggestion = nearest(key, allowed);
		const hint = suggestion ? `. Did you mean --${suggestion}?` : "";
		console.error(`Error: Unknown flag --${key} for '${command}'${hint}`);
		console.error(`Run 'agent-memory ${command} --help' for valid flags.`);
		process.exit(1);
	}
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

function openExternalUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	try {
		const child =
			process.platform === "darwin"
				? spawn("open", [parsed.toString()], { detached: true, stdio: "ignore" })
				: process.platform === "win32"
					? spawn("explorer.exe", [parsed.toString()], { detached: true, stdio: "ignore" })
					: spawn("xdg-open", [parsed.toString()], { detached: true, stdio: "ignore" });
		child.unref();
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Color output (respects NO_COLOR and non-TTY)
// ---------------------------------------------------------------------------

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
const COLORS = {
	reset: USE_COLOR ? "\x1b[0m" : "",
	dim: USE_COLOR ? "\x1b[2m" : "",
	bold: USE_COLOR ? "\x1b[1m" : "",
	red: USE_COLOR ? "\x1b[31m" : "",
	green: USE_COLOR ? "\x1b[32m" : "",
	yellow: USE_COLOR ? "\x1b[33m" : "",
	cyan: USE_COLOR ? "\x1b[36m" : "",
};

function colorize(text: string, color: keyof typeof COLORS): string {
	return `${COLORS[color]}${text}${COLORS.reset}`;
}

const MARK_OK = colorize("✓", "green");
const MARK_WARN = colorize("⚠", "yellow");
const MARK_FAIL = colorize("✗", "red");

function readCachedProUsage(): Record<
	string,
	{ used?: number; limit?: number; remaining?: number; resetAt?: string; state?: string; recordedAt?: string }
> {
	try {
		const path = `${getMemoryDir()}/state/pro-usage.json`;
		return JSON.parse(fs.readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function printProUsageCounters(): void {
	const cache = readCachedProUsage();
	const entries = Object.entries(cache);
	if (entries.length === 0) return;
	console.log("Free preview usage today (local cache):");
	for (const [capability, entry] of entries) {
		const used = entry.used ?? 0;
		const limit = entry.limit ?? 0;
		const resetIn = formatResetTime(entry.resetAt);
		const label = capability === "session" ? "Session captures" : capability;
		const marker = entry.state === "exhausted" ? " (exhausted)" : "";
		console.log(`  ${label.padEnd(20)} ${used}/${limit} · resets in ${resetIn}${marker}`);
	}
	console.log("");
}

function printProOverview(installed: boolean): void {
	console.log("");
	console.log("Core remembers what you save. Pro learns from what you do.");
	console.log("");
	console.log("AgentMemory Pro:");
	console.log(
		'  Remember past sessions      Ask "what did we decide about auth?" across Claude Code, Codex, and Cursor.',
	);
	console.log("  Learn from your patterns    Turn repeated corrections into memory you can inspect and undo.");
	console.log("  Private by default          Memory and session content index locally and never leave this machine.");
	console.log("");
	if (installed) {
		printProUsageCounters();
		console.log("Try it:");
		console.log('  agent-memory recall "what did we decide about authentication?"');
		console.log("  agent-memory learn");
		console.log("  agent-memory dashboard");
	} else {
		console.log("No account. No email. Free preview starts now:");
		console.log("  agent-memory pro install");
	}
}

function printPluginResult(result: PluginBootstrapResultV1, json: boolean, allowBrowser: boolean): void {
	if (json) {
		output(result, true);
	} else if (result.command === "plugin.list" && result.plugins) {
		for (const plugin of result.plugins) {
			const state = plugin.available ? "available" : plugin.installed ? plugin.entitlement : "not installed";
			console.log(`${plugin.name}: ${state}`);
		}
		printProOverview(Boolean(result.bundle));
	} else {
		const version = result.bundle?.version ? ` ${result.bundle.version}` : "";
		let showOverview = false;
		switch (result.result) {
			case "installed":
				console.log(`AgentMemory Pro${version} installed.`);
				showOverview = true;
				break;
			case "upgraded":
				console.log(`AgentMemory Pro upgraded to${version}.`);
				showOverview = true;
				break;
			case "current":
				console.log(
					result.bundle
						? `AgentMemory Pro${version} is installed and ready.`
						: "AgentMemory Pro is not installed.",
				);
				showOverview = Boolean(result.bundle);
				break;
			case "update_available":
				console.log(`AgentMemory Pro${version} has an update available.`);
				break;
			case "uninstalled":
				console.log("AgentMemory Pro executable components were removed. Memory and billing state were preserved.");
				break;
			case "not_installed":
				console.log("AgentMemory Pro is not installed.");
				console.log("Run: agent-memory pro install");
				break;
			case "auth_required":
				console.log("Run agent-memory pro install to activate the free preview.");
				break;
			case "renewal_required":
				console.log("Renew AgentMemory Pro to continue using paid capabilities.");
				break;
			default:
				console.log(result.error?.message ?? "AgentMemory Pro is currently unavailable.");
		}
		if (showOverview) printProOverview(true);
	}

	if (result.nextAction) {
		if (allowBrowser && openExternalUrl(result.nextAction.url)) {
			if (!json) console.log("Opened the AgentMemory account website.");
		} else if (!json) {
			console.log(`Open: ${result.nextAction.url}`);
		}
		if (!json && result.nextAction.userCode) console.log(`Code: ${result.nextAction.userCode}`);
	}
	if (!result.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdContext(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const noSearch = hasFlag(flags, "no-search");
	const query = getFlag(flags, "query") ?? "";
	const layer = getFlag(flags, "layer");

	ensureDirs();
	if (!noSearch && query) await ensureQmdAvailableForSync();
	const searchResults = noSearch ? "" : await searchRelevantMemories(query);
	const coreContext =
		layer === "stable"
			? buildStableContext()
			: layer === "dynamic"
				? buildDynamicContext(searchResults, query)
				: buildMemoryContext(searchResults);
	let pluginSections: PluginContextSectionV1[] = [];
	try {
		pluginSections = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).provideContext({
			host: "agent-memory-cli",
			cwd: process.cwd(),
			query: query || undefined,
			signal: new AbortController().signal,
		});
	} catch {
		// Optional Pro context must never make public-core context unavailable.
	}
	const pluginContext = pluginSections.map((section) => `${section.label}\n\n${section.content}`).join("\n\n");
	const context = [coreContext, pluginContext].filter(Boolean).join("\n\n");

	if (json) {
		output({ context, directory: getMemoryDir(), ...(pluginSections.length ? { pluginSections } : {}) }, true);
	} else {
		if (context) {
			process.stdout.write(context);
		}
	}
}

/**
 * Read stdin (up to 1 MB) as JSON. Returns null on non-TTY stdin, oversized
 * payload, or JSON parse errors — the caller emits empty stdout in those
 * cases so a malformed harness hook payload never poisons the conversation.
 */
async function readStdinJson<T = Record<string, unknown>>(): Promise<T | null> {
	if (process.stdin.isTTY) return null;
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of process.stdin) {
			const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
			total += buffer.length;
			if (total > 1_000_000) return null;
			chunks.push(buffer);
		}
		const text = Buffer.concat(chunks).toString("utf-8").trim();
		if (!text) return null;
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

/**
 * Sanitize a user prompt into a search query. Mirrors the discipline in
 * `searchRelevantMemories`: strip control chars, cap length. Never throws.
 */
function sanitizePromptQuery(prompt: unknown): string {
	if (typeof prompt !== "string") return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars.
	const stripped = prompt.replace(/[\x00-\x1f\x7f]/g, " ");
	return stripped.trim().slice(0, 200);
}

/**
 * UserPromptSubmit hook handler — fires on every user prompt in per-turn mode.
 * Reads the harness's JSON payload from stdin, emits the dynamic context layer
 * (daily logs + qmd search + plugin context), and refreshes background workers
 * un-metered. Silently degrades to empty stdout on any failure or timeout so
 * a broken install never blocks the user.
 */
async function cmdUserPromptSubmit(_flags: Record<string, string | boolean>): Promise<void> {
	const TIMEOUT_MS = 3_000;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve();
		}, TIMEOUT_MS);
	});

	const work = (async () => {
		const payload = await readStdinJson<{ user_input?: unknown; prompt?: unknown }>();
		if (!payload) return;
		const query = sanitizePromptQuery(payload.user_input ?? payload.prompt);
		ensureDirs();
		if (query) await ensureQmdAvailableForSync({ signal: controller.signal });
		const searchResults = query ? await searchRelevantMemories(query, { signal: controller.signal }) : "";
		const coreContext = buildDynamicContext(searchResults, query);
		const runtime = new InstalledPluginRuntimeV1({ coreVersion: VERSION });
		let pluginSections: PluginContextSectionV1[] = [];
		try {
			pluginSections = await runtime.provideContext({
				host: "agent-memory-cli",
				cwd: process.cwd(),
				query: query || undefined,
				signal: controller.signal,
			});
		} catch {
			// Plugin context is optional — silent degradation.
		}
		try {
			await runtime.refreshBackgroundWorkers({
				host: "agent-memory-cli",
				cwd: process.cwd(),
				signal: controller.signal,
			});
		} catch {
			// Worker refresh must never block the user prompt.
		}
		const pluginContext = pluginSections.map((section) => `${section.label}\n\n${section.content}`).join("\n\n");
		const context = [coreContext, pluginContext].filter(Boolean).join("\n\n");
		if (context) process.stdout.write(context);
	})().catch(() => {
		// Any failure in the per-turn hook must be swallowed — never emit an
		// error message that would leak into the harness's context.
	});

	await Promise.race([work, timeout]);
	if (timer) clearTimeout(timer);
}

// How many Stop events must elapse (per session_id) before the periodic
// memory-write nudge fires again. Balances "long sessions get checked
// repeatedly" against "don't block every single turn". Deliberately short —
// most real sessions are well under a dozen turns, so a wider interval meant
// the nudge rarely fired in practice (see stop-hook.json in the wild: sessions
// topping out around 7 turns, zero nags ever recorded).
const STOP_NAG_INTERVAL = 6;
// Bound state/stop-hook.json so it can't grow unboundedly across many sessions.
const STOP_HOOK_MAX_SESSIONS = 50;

interface StopHookSessionState {
	count: number;
	lastNagCount: number;
	lastSeenAt: number;
}

interface StopHookState {
	sessions: Record<string, StopHookSessionState>;
}

function stopHookStatePath(): string {
	return `${getMemoryDir()}/state/stop-hook.json`;
}

function readStopHookState(): StopHookState {
	try {
		const raw = fs.readFileSync(stopHookStatePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<StopHookState>;
		return { sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {} };
	} catch {
		return { sessions: {} };
	}
}

function writeStopHookState(state: StopHookState): void {
	const entries = Object.entries(state.sessions).sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
	const pruned = Object.fromEntries(entries.slice(0, STOP_HOOK_MAX_SESSIONS));
	const stateDir = `${getMemoryDir()}/state`;
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(stopHookStatePath(), `${JSON.stringify({ sessions: pruned }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Bump the Stop-event counter for `sessionId` and report whether the
 * periodic memory-write nudge should fire this time. Never throws — a
 * corrupt or unwritable state file just means the nudge falls back to
 * "never fires" rather than breaking the Stop hook.
 */
function shouldNagOnStop(sessionId: string, now: number): boolean {
	try {
		const state = readStopHookState();
		const existing = state.sessions[sessionId] ?? { count: 0, lastNagCount: 0, lastSeenAt: now };
		const count = existing.count + 1;
		const shouldNag = count - existing.lastNagCount >= STOP_NAG_INTERVAL;
		state.sessions[sessionId] = {
			count,
			lastNagCount: shouldNag ? count : existing.lastNagCount,
			lastSeenAt: now,
		};
		writeStopHookState(state);
		return shouldNag;
	} catch {
		return false;
	}
}

const STOP_NAG_REASON =
	"Before stopping: if this session produced a durable fact, bug fix, or decision worth remembering, " +
	'capture it now — `agent-memory write --content "..."` for a daily note, or `--target long_term` for a ' +
	"durable fact — and update the scratchpad with any open follow-ups. If there's nothing worth recording, " +
	"ignore this and stop normally.";

/**
 * Stop hook handler — fires at the end of every assistant turn (not once per
 * session). Blocks at most once every STOP_NAG_INTERVAL turns per session_id
 * to nudge a memory-write check without being disruptive. Always allows the
 * stop (empty stdout) on missing session_id, `stop_hook_active` (Claude Code's
 * own re-entrancy signal — never block twice in a row), or any internal error.
 */
async function cmdStop(_flags: Record<string, string | boolean>): Promise<void> {
	const TIMEOUT_MS = 3_000;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve();
		}, TIMEOUT_MS);
	});

	const work = (async () => {
		const payload = await readStdinJson<{ session_id?: unknown; stop_hook_active?: unknown }>();
		const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
		if (!sessionId || payload?.stop_hook_active === true) return;
		if (shouldNagOnStop(sessionId, Date.now())) {
			process.stdout.write(JSON.stringify({ decision: "block", reason: STOP_NAG_REASON }));
		}
	})().catch(() => {
		// Any failure in the Stop hook must be swallowed — never trap the user
		// in a stuck session over a broken memory-write nudge.
	});

	await Promise.race([work, timeout]);
	if (timer) clearTimeout(timer);
}

async function cmdWrite(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const target = getFlag(flags, "target") ?? "daily";
	const content = getFlag(flags, "content");
	const mode = getFlag(flags, "mode") ?? "append";
	const topic = getFlag(flags, "topic");
	const date = getFlag(flags, "date");
	const sourceUri = getFlag(flags, "source-uri");

	if (!["long_term", "daily", "topic"].includes(target)) {
		exitError("--target must be 'long_term', 'daily', or 'topic' (default: daily)", json);
	}
	if (!["append", "overwrite"].includes(mode)) {
		exitError("--mode must be 'append' or 'overwrite'", json);
	}
	if (!content) {
		exitError("--content is required", json);
	}

	const result = await memoryWrite({
		target: target as "long_term" | "daily" | "topic",
		content,
		mode: mode as "append" | "overwrite",
		sessionId: "cli",
		topic,
		date,
		sourceUri,
	});
	if (result.isError) exitError(result.text.replace(/^Error:\s*/, ""), json);
	output(json ? { ok: true, ...result.details } : result.text.split("\n\n", 1)[0], json);
}

async function cmdRead(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const target = getFlag(flags, "target");
	const date = getFlag(flags, "date");
	const topic = getFlag(flags, "topic");

	if (!target || !["long_term", "scratchpad", "daily", "list", "topic", "topics"].includes(target)) {
		exitError("--target must be 'long_term', 'scratchpad', 'daily', 'list', 'topic', or 'topics'", json);
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

	if (target === "topics") {
		try {
			const files = fs
				.readdirSync(getTopicsDir())
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (json) {
				output({ files }, true);
			} else if (files.length === 0) {
				console.log("No topics found.");
			} else {
				console.log(`Topics:\n${files.map((f) => `- ${f}`).join("\n")}`);
			}
		} catch {
			output(json ? { files: [] } : "No topics directory.", json);
		}
		return;
	}

	if (target === "topic") {
		if (!topic) {
			exitError("--topic is required when --target is 'topic'", json);
		}
		const slug = slugifyTopic(topic);
		const filePath = topicPath(slug);
		const content = readFileSafe(filePath);
		if (!content) {
			output(json ? { content: null, topic } : `No topic file found for ${topic}.`, json);
			return;
		}
		output(json ? { content, topic, slug, path: filePath } : content, json);
		return;
	}

	if (target === "scratchpad") {
		const content = readFileSafe(getScratchpadFile());
		if (!content?.trim()) {
			output(json ? { content: null } : "SCRATCHPAD.md is empty or does not exist.", json);
			return;
		}
		output(json ? { content, path: getScratchpadFile() } : content, json);
		return;
	}

	// long_term
	const content = readFileSafe(getMemoryFile());
	if (!content) {
		output(json ? { content: null } : "MEMORY.md is empty or does not exist.", json);
		return;
	}
	output(json ? { content, path: getMemoryFile() } : content, json);
}

async function cmdScratchpad(flags: Record<string, string | boolean>, positional: string[]) {
	const json = hasFlag(flags, "json");
	const action = positional[0];
	const text = getFlag(flags, "text");

	if (!action || !["add", "done", "undo", "clear_done", "list"].includes(action)) {
		exitError("Usage: agent-memory scratchpad <add|done|undo|clear_done|list> [--text <text>]", json);
	}

	ensureDirs();
	const spFile = getScratchpadFile();
	const existing = readFileSafe(spFile) ?? "";
	let items = parseScratchpad(existing).map((item) => ({
		...item,
		text: redactSecrets(item.text).content,
		meta: redactSecrets(item.meta).content,
	}));

	if (action === "list") {
		if (items.length === 0) {
			output(json ? { items: [], count: 0, open: 0 } : "Scratchpad is empty.", json);
			return;
		}
		if (json) {
			output(
				{
					items: items.map((i) => ({ done: i.done, text: i.text })),
					count: items.length,
					open: items.filter((i) => !i.done).length,
				},
				true,
			);
		} else {
			console.log(serializeScratchpad(items));
		}
		return;
	}

	if (action === "add") {
		if (!text) exitError("--text is required for add", json);
		const ts = nowTimestamp();
		const safeText = redactSecrets(text!).content;
		items.push({ done: false, text: safeText, meta: `<!-- ${ts} [cli] -->` });
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(json ? { ok: true, action, text: safeText } : `Added: - [ ] ${safeText}`, json);
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
			exitError(`No matching ${targetDone ? "open" : "done"} item found for: "${text}"`, json);
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
		output(json ? { ok: true, action, removed } : `Cleared ${removed} done item(s).`, json);
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
		exitError(`qmd collection '${collName}' not found. Run: agent-memory setup`, json);
	}

	try {
		const { results, stderr } = await runQmdSearch(mode, query!, limit);

		let recallHits: unknown[] = [];
		if (results.length === 0) {
			try {
				const runtime = new InstalledPluginRuntimeV1({ coreVersion: VERSION });
				const recallResult = await runtime.run("recall", {
					args: [query!],
					flags: { limit: String(limit) },
					signal: new AbortController().signal,
				});
				if (recallResult?.ok && Array.isArray(recallResult.data) && recallResult.data.length > 0) {
					recallHits = recallResult.data;
				}
			} catch {
				// Pro not installed or recall unavailable — fall through to normal empty result
			}
		}

		if (json) {
			if (results.length === 0 && recallHits.length > 0) {
				output({ mode, query, source: "recall", count: recallHits.length, results: recallHits }, true);
			} else {
				output({ mode, query, source: "qmd", count: results.length, results }, true);
			}
			return;
		}

		if (results.length === 0) {
			if (recallHits.length > 0) {
				console.log(
					`No hits in local memory files for "${query}" — falling back to prior sessions via Pro recall (${recallHits.length} hit(s)):\n`,
				);
				console.log(JSON.stringify(recallHits, null, 2));
				return;
			}
			const needsEmbed = /need embeddings/i.test(stderr ?? "");
			if (needsEmbed && (mode === "semantic" || mode === "deep")) {
				console.log(`No results found. qmd reports missing embeddings — run: qmd embed`);
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
		exitError(`Search failed: ${err instanceof Error ? err.message : String(err)}`, json);
	}
}

function cmdInstallSkills(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const uninstall = hasFlag(flags, "uninstall");

	if (uninstall) {
		const report = uninstallSkills();

		if (!report.ok) {
			exitError(report.error ?? "Failed to uninstall skills.", json);
		}

		if (json) {
			output(report, true);
			return;
		}

		for (const item of report.removed) {
			console.log(`Uninstalled ${item.label}: ${item.path}`);
		}
		for (const item of report.skipped) {
			console.log(`Skipping ${item.label} (${item.reason})`);
		}
		if (report.removed.length === 0) {
			console.log("No skills were installed.");
		}
		return;
	}

	const report = installSkills();

	if (!report.ok) {
		exitError(report.error ?? "Failed to install skills.", json);
	}

	if (json) {
		output(report, true);
		return;
	}

	if (report.checked.length > 0) {
		for (const item of report.checked) {
			if (item.status === "detected") {
				console.log(`Detecting ${item.label}... found`);
			} else {
				console.log(`Detecting ${item.label}... not found (${item.reason ?? "unknown"})`);
			}
		}
	} else if (report.detected.length === 0) {
		console.log("No supported agent installations detected.");
	} else {
		const detectedLabels = report.detected.map((item) => item.label).join(", ");
		console.log(`Detected: ${detectedLabels}`);
	}

	if (report.installed.length === 0) {
		console.log("No skills installed.");
	} else {
		for (const item of report.installed) {
			console.log(`Installed ${item.label}: ${item.path}`);
		}
	}

	if (report.skipped.length > 0) {
		for (const item of report.skipped) {
			console.log(`Skipped ${item.label} (${item.reason})`);
		}
	}

	if (report.installed.length > 0 && process.stdout.isTTY) {
		const first = report.installed[0].label;
		console.log("");
		console.log(`Next: open ${first} and ask ${colorize('"what do you remember about me?"', "cyan")} to verify.`);
	}
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
		if (!answer) return defaultYes;
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function cmdInstallHooks(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	const requested = getFlag(flags, "only");
	const requestedKeys = requested ? new Set(requested.split(",").map((value) => value.trim())) : null;
	const modeFlag = getFlag(flags, "mode");
	if (modeFlag !== undefined && modeFlag !== "stable" && modeFlag !== "per-turn") {
		exitError(`--mode must be 'stable' or 'per-turn' (got ${modeFlag})`, json);
	}
	const mode: HookMode = (modeFlag as HookMode | undefined) ?? "per-turn";
	const { homeDir, targets } = detectHookAgents();
	if (!homeDir) exitError("Home directory not found.", json);
	const eligible = targets.filter(
		(target) => target.supported && target.detected && (!requestedKeys || requestedKeys.has(target.key)),
	);
	if (!eligible.length) {
		if (json) return output({ ok: true, homeDir, results: [] }, true);
		return output("No eligible agents. Nothing to install.", false);
	}
	// Consider an agent "already installed" only when the wiring matches the requested mode.
	// per-turn requires BOTH SessionStart and UserPromptSubmit; stable requires SessionStart AND
	// no UserPromptSubmit (so a downgrade correctly removes the per-turn hook).
	const isFullyInstalled = (target: (typeof eligible)[number]): boolean => {
		if (!homeDir) return false;
		const session = isHookInstalled(homeDir, target.key);
		if (!session) return false;
		if (target.key !== "claude" && target.key !== "codex") return true; // cursor/opencode: static only
		const prompt = isUserPromptSubmitInstalled(homeDir, target.key);
		if (mode === "per-turn" ? !prompt : prompt) return false;
		// Stop (write-side nudge) is Claude Code only and mode-independent.
		if (target.key === "claude") {
			if (!isStopHookInstalled(homeDir, target.key)) return false;
		}
		return true;
	};
	const alreadyInstalled = eligible.filter(isFullyInstalled);
	const pending = eligible.filter((target) => !alreadyInstalled.includes(target));
	if (!json && alreadyInstalled.length) {
		const labels = alreadyInstalled.map((target) => target.label).join(", ");
		console.log(`Automatic context already active for: ${labels}.`);
	}
	if (!pending.length) {
		if (json) {
			return output(
				{
					ok: true,
					homeDir,
					results: alreadyInstalled.map((target) => ({
						key: target.key,
						label: target.label,
						installed: false,
						reason: "already installed",
						mode,
					})),
				},
				true,
			);
		}
		return output("Nothing to install.", false);
	}
	const selected = new Set<HookAgentKey>();
	const applyAll = hasFlag(flags, "yes") || hasFlag(flags, "all") || !process.stdin.isTTY;
	const hookLabel = mode === "per-turn" ? "SessionStart + UserPromptSubmit hooks" : "SessionStart hook";
	for (const target of pending) {
		if (applyAll || (await promptYesNo(`Install ${hookLabel} for ${target.label}?`, true))) selected.add(target.key);
	}
	if (!selected.size) {
		if (json) return output({ ok: true, homeDir, results: [] }, true);
		return output("Nothing selected. Skipped.", false);
	}
	const report = installHooks(selected, mode);
	if (!report.ok) exitError(report.error ?? "install failed", json);
	if (json) return output(report, true);
	for (const result of report.results) {
		console.log(
			result.installed
				? `Installed ${result.label} hook (${result.mode ?? mode}): ${result.path}`
				: `Skipped ${result.label} (${result.reason ?? "unknown"})`,
		);
	}
}

function cmdUninstallHooks(flags: Record<string, string | boolean>): void {
	const json = hasFlag(flags, "json");
	const only = getFlag(flags, "only");
	const agents = only ? new Set(only.split(",").map((value) => value.trim()) as HookAgentKey[]) : undefined;
	const report = uninstallHooks(agents);
	if (!report.ok) exitError(report.error ?? "uninstall failed", json);
	if (json) {
		output(report, true);
		return;
	}
	for (const result of report.results) {
		console.log(
			result.installed
				? `Uninstalled ${result.label}: ${result.path}`
				: `Skipped ${result.label} (${result.reason ?? "unknown"})`,
		);
	}
}

function cmdCompletion(flags: Record<string, string | boolean>, positional: string[]): void {
	const requestedShell = positional[0];
	const shells: CompletionShell[] = ["bash", "zsh", "fish", "powershell"];
	if (requestedShell && !shells.includes(requestedShell as CompletionShell))
		exitError(
			`Unsupported shell '${requestedShell}'. Choose bash, zsh, fish, or powershell.`,
			hasFlag(flags, "json"),
		);
	const shell = (requestedShell as CompletionShell | undefined) ?? detectCompletionShell();
	if (!shell)
		exitError("Could not detect your shell. Specify bash, zsh, fish, or powershell.", hasFlag(flags, "json"));
	if (hasFlag(flags, "stdout")) {
		process.stdout.write(generateCompletion(shell));
		return;
	}
	const result = installCompletion(shell);
	if (hasFlag(flags, "json")) {
		output(result, true);
		return;
	}
	console.log(`Installed ${shell} completion: ${result.completionPath}`);
	if (result.profilePath)
		console.log(`${result.profileUpdated ? "Configured" : "Already configured"}: ${result.profilePath}`);
}

async function cmdSync(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();

	const qmdFound = await ensureQmdAvailableForSync();
	if (!qmdFound) {
		exitError("qmd is not installed. Install: bun install -g https://github.com/tobi/qmd", json);
	}

	const collName = getCollectionName();
	const hasCollection = await checkCollection(collName);
	if (!hasCollection) {
		exitError(`qmd collection '${collName}' not found. Run: agent-memory setup`, json);
	}

	const result = await runQmdSync();

	if (json) {
		output({ ok: result.updateOk && result.embedOk, updateOk: result.updateOk, embedOk: result.embedOk }, true);
	} else {
		if (result.updateOk) {
			console.log("qmd update: ok");
		} else {
			console.log("qmd update: failed");
		}
		if (result.embedOk) {
			console.log("qmd embed: ok");
		} else {
			console.log("qmd embed: failed");
		}
		if (result.updateOk && result.embedOk) {
			console.log("\nIndex fully synced.");
		}
	}
}

async function cmdInit(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const nonInteractive = json || hasFlag(flags, "yes") || !process.stdin.isTTY || !process.stdout.isTTY;
	const skipSkills = hasFlag(flags, "skip-skills");
	const skipHooks = hasFlag(flags, "skip-hooks");

	ensureDirs();
	const dir = getMemoryDir();

	const qmdFound = await detectQmd();
	let collectionCreated = false;
	let indexUpdated = false;
	let embedStarted = false;

	if (qmdFound) {
		const collName = getCollectionName();
		const hasCollection = await checkCollection(collName);
		if (!hasCollection) {
			collectionCreated = await setupQmdCollection();
		}
		await ensureQmdAvailableForUpdate();
		await runQmdUpdateNow();
		indexUpdated = true;
		const child = runQmdEmbedDetached();
		embedStarted = child !== null;
	}

	if (json) {
		output({ ok: true, directory: dir, qmd: qmdFound, collectionCreated, indexUpdated, embedStarted }, true);
		return;
	}

	// ---------------------------------------------------------------------
	// Non-interactive path (backward compatible with existing `--yes` / CI use)
	// ---------------------------------------------------------------------
	if (nonInteractive) {
		console.log(`Memory directory: ${dir}`);
		console.log(`  MEMORY.md, SCRATCHPAD.md, daily/, topics/ ready.`);
		if (qmdFound) {
			console.log(`  Search index ready.`);
			if (embedStarted) console.log(`  Semantic search is preparing in the background.`);
		} else {
			console.log(`  Search index unavailable — keyword search remains available.`);
			console.log(`  Optional: install qmd with bun install -g https://github.com/tobi/qmd`);
		}
		return;
	}

	// ---------------------------------------------------------------------
	// Interactive wizard
	// ---------------------------------------------------------------------
	console.log("");
	console.log(colorize("Welcome to AgentMemory.", "bold"));
	console.log(colorize("Persistent memory for Claude Code, Codex, Cursor, and other coding agents.", "dim"));
	console.log("");
	console.log(`  ${MARK_OK} Memory directory: ${dir}`);
	if (qmdFound) {
		console.log(`  ${MARK_OK} Search index: ${collectionCreated ? "created" : "ready"}`);
	} else {
		console.log(`  ${MARK_WARN} qmd not installed — search will be limited.`);
		console.log(`      ${colorize("Install: bun install -g https://github.com/tobi/qmd", "cyan")}`);
	}
	console.log("");

	// Detect which agent hosts are present
	const { targets } = detectHookAgents();
	const detected = targets.filter((target) => target.detected && target.supported);
	if (detected.length === 0) {
		console.log(colorize("  No supported agents detected on this machine.", "yellow"));
		console.log(colorize("  Install Claude Code, Codex, or Cursor, then re-run.", "dim"));
	} else {
		console.log(colorize("Detected agents:", "bold"));
		for (const target of detected) console.log(`  ${MARK_OK} ${target.label}`);
		console.log("");
	}

	// Step 1: install skills
	if (!skipSkills && detected.length > 0) {
		if (await promptYesNo("Install the AgentMemory skill so your agents can use memory?", true)) {
			cmdInstallSkills({});
		}
	}
	console.log("");

	// Step 2: install SessionStart hooks (delegates to existing interactive path)
	if (!skipHooks && detected.length > 0) {
		if (await promptYesNo("Install SessionStart hooks so context loads automatically?", true)) {
			await cmdInstallHooks({});
		}
	}
	console.log("");

	// Step 3: seed MEMORY.md so the skill's cold start isn't empty
	const memFile = getMemoryFile();
	const existing = readFileSafe(memFile) ?? "";
	if (existing.trim().length === 0) {
		const platform = process.platform === "darwin" ? "macOS" : process.platform;
		const seed = `<!-- ${nowTimestamp()} [init] -->\nAgentMemory initialized on ${platform} · ${todayStr()}. First session: check the scratchpad and daily log for context.\n`;
		fs.writeFileSync(memFile, seed);
		console.log(`  ${MARK_OK} Seeded MEMORY.md with a first entry so your agent has something to read.`);
	}

	// Step 4: offer Pro preview if not installed
	try {
		const plugin = await createDefaultPluginBootstrap(VERSION).list();
		if (plugin.result === "not_installed") {
			printProPitch("first-run");
			if (await promptYesNo("Preview what Pro would find in your existing session history?", true)) {
				await cmdProPreview({});
			}
		}
	} catch {
		// Commercial discovery must never make core initialization fail.
	}

	// Cheat sheet
	console.log("");
	console.log(colorize("You're set. Try these:", "bold"));
	console.log('  agent-memory save "made progress on <thing>"    — quick note in today\'s log');
	console.log('  agent-memory note "follow up on <thing>"        — persistent todo item');
	console.log('  agent-memory recall "what did we decide about X?" — search past sessions (Pro)');
	console.log("  agent-memory doctor                              — health check");
	console.log("");
	console.log(
		colorize(
			`Now open one of ${detected.map((target) => target.label).join(", ") || "your agents"} and ask: "what do you remember about me?"`,
			"cyan",
		),
	);
}

// ---------------------------------------------------------------------------
// Setup usage stats
// ---------------------------------------------------------------------------

interface ProUsageCacheEntry {
	used?: number;
	limit?: number;
	remaining?: number;
	resetAt?: string;
	state?: string;
}

function readProUsageCache(): Record<string, ProUsageCacheEntry> {
	try {
		return JSON.parse(fs.readFileSync(`${getMemoryDir()}/state/pro-usage.json`, "utf-8")) as Record<
			string,
			ProUsageCacheEntry
		>;
	} catch {
		return {};
	}
}

async function printSetupUsageStats(pluginInstalled: boolean): Promise<void> {
	if (!pluginInstalled) return;
	try {
		const usage = readProUsageCache();
		const recall = usage.recall;
		const learn = usage.learn;

		const recallStr =
			recall?.used !== undefined && recall?.limit !== undefined
				? `${recall.used}/${recall.limit} recalls today`
				: `0/20 recalls today`;
		const learnStr =
			learn?.used !== undefined && learn?.limit !== undefined
				? `${learn.used}/${learn.limit} learnings today`
				: `0/5 learnings today`;

		console.log(colorize(`  Plan: Free  ·  ${recallStr}  ·  ${learnStr}`, "dim"));

		let sessionStats: { claude: number; codex: number; pi: number } | null = null;
		try {
			const result = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).run("index", {
				args: [],
				flags: {},
				signal: new AbortController().signal,
			});
			if (result?.ok && result.data && typeof result.data === "object") {
				const stats = (result.data as { stats?: { discovered?: Record<string, number> } }).stats;
				if (stats?.discovered) {
					sessionStats = {
						claude: stats.discovered.claude ?? 0,
						codex: stats.discovered.codex ?? 0,
						pi: stats.discovered.pi ?? 0,
					};
				}
			}
		} catch {
			// best-effort
		}

		if (sessionStats !== null) {
			const total = sessionStats.claude + sessionStats.codex + sessionStats.pi;
			if (total > 0) {
				const parts = (
					[
						sessionStats.claude > 0 ? `Claude Code ${sessionStats.claude.toLocaleString("en-US")}` : null,
						sessionStats.codex > 0 ? `Codex ${sessionStats.codex.toLocaleString("en-US")}` : null,
						sessionStats.pi > 0 ? `Pi ${sessionStats.pi.toLocaleString("en-US")}` : null,
					] as (string | null)[]
				)
					.filter(Boolean)
					.join("  ·  ");
				console.log(colorize(`  Sessions indexed: ${total.toLocaleString("en-US")}  (${parts})`, "dim"));
			}
		}

		console.log("");
	} catch {
		// stats are best-effort; never block setup completion
	}
}

/**
 * One-shot idempotent installer. Runs init + install-skills + install-hooks +
 * plugin install (if a bundle is discoverable) and then prints a one-page status
 * summary. Each step is a no-op when the target is already good, so `setup` is
 * safe to re-run after upgrades.
 *
 * The point of `setup` is that a first-time user only has to remember ONE
 * command. `init`, `install-skills`, `install-hooks`, `plugin install` still
 * exist for scripts and for finer control, but no one needs them for the happy
 * path.
 *
 * Interactivity model: on an interactive TTY (and when not `--json`) setup
 * will prompt exactly once — to install AgentMemory Pro — because the benefits
 * (cross-session recall, learn-from-corrections) are invisible without it.
 * With `--yes` we auto-install Pro; with `--json`, `--skip-plugin`, or a
 * non-TTY stdin/stdout we fall back to the previous passive hint so scripted
 * setups keep working unchanged.
 */
async function cmdSetup(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const skipSkills = hasFlag(flags, "skip-skills");
	const skipHooks = hasFlag(flags, "skip-hooks");
	const skipPlugin = hasFlag(flags, "skip-plugin");
	const skipMcp = hasFlag(flags, "skip-mcp");
	const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);

	// setup is non-interactive by design. Sub-steps that print progress noise get their
	// stdout captured when we're in json mode, so the whole command emits ONE envelope.
	const subFlags = { yes: true } as Record<string, string | boolean>;
	const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

	const runQuiet = async (fn: () => Promise<void> | void): Promise<void> => {
		if (!json) {
			await fn();
			return;
		}
		const originalLog = console.log;
		const originalInfo = console.info;
		console.log = () => {};
		console.info = () => {};
		try {
			await fn();
		} finally {
			console.log = originalLog;
			console.info = originalInfo;
		}
	};

	// Step 1: memory dir + qmd
	try {
		await runQuiet(() => cmdInit({ ...subFlags, "skip-skills": true, "skip-hooks": true }));
		steps.push({ name: "memory", ok: true, detail: getMemoryDir() });
	} catch (error) {
		steps.push({ name: "memory", ok: false, detail: (error as Error).message });
	}

	// Step 2: skills for detected agents
	if (!skipSkills) {
		try {
			await runQuiet(() => cmdInstallSkills(subFlags));
			steps.push({ name: "skills", ok: true });
		} catch (error) {
			steps.push({ name: "skills", ok: false, detail: (error as Error).message });
		}
	} else {
		steps.push({ name: "skills", ok: true, detail: "skipped" });
	}

	// Step 3: hooks (uses the improved preflight — silent when all already installed)
	if (!skipHooks) {
		try {
			await runQuiet(() => cmdInstallHooks(subFlags));
			steps.push({ name: "hooks", ok: true });
		} catch (error) {
			steps.push({ name: "hooks", ok: false, detail: (error as Error).message });
		}
	} else {
		steps.push({ name: "hooks", ok: true, detail: "skipped" });
	}

	// Step 4: install the local session-intelligence plugin by default. The free
	// allowance is part of the product experience, not an opt-in gate: users
	// should feel recall and learning before they ever see an upgrade prompt.
	let pluginJustInstalled = false;
	if (!skipPlugin) {
		const receiptPath = path.join(
			process.env.HOME ?? "",
			".agent-memory/system/plugins/receipts/agentmemory.pro.json",
		);
		const readReceiptVersion = (): string | undefined => {
			try {
				const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as { version?: string };
				return receipt.version;
			} catch {
				return undefined;
			}
		};

		if (fs.existsSync(receiptPath)) {
			const version = readReceiptVersion();
			steps.push({
				name: "plugin",
				ok: true,
				detail: version ? `${version} installed` : "installed",
			});
		} else {
			// The free allowance is enabled automatically. `--skip-plugin` is the
			// explicit escape hatch for users who want core-only setup.
			const manager = createDefaultPluginBootstrap(VERSION);

			// Run install, capture the structured result (don't drop it), and
			// auto-recover from `version_conflict` — that just means a stale
			// bundle from an earlier dev iteration is sitting in
			// ~/.agent-memory/system/plugins/bundles/... with a different SHA.
			// A manual `plugin uninstall && plugin install` fixes it, so we do
			// the same automatically once during setup.
			const runInstall = async (): Promise<PluginBootstrapResultV1> => {
				let outcome!: PluginBootstrapResultV1;
				await runQuiet(async () => {
					outcome = await manager.install({ channel: "stable", allowAuthentication: interactive });
				});
				return outcome;
			};

			try {
				let installResult = await runInstall();
				if (!installResult.ok && installResult.error?.code === "version_conflict") {
					// `manager.uninstall()` only wipes bundles referenced by a
					// receipt. On version_conflict there is no receipt (that's
					// the whole point — an orphan bundle from an earlier failed
					// install is on disk with a different SHA). Try the API path
					// first, then fall back to removing the specific version
					// directory under ~/.agent-memory/system/plugins/bundles/.
					await runQuiet(async () => {
						await manager.uninstall();
					});
					try {
						const bundlesRoot = path.join(
							process.env.HOME ?? "",
							".agent-memory/system/plugins/bundles/agentmemory.pro",
						);
						if (fs.existsSync(bundlesRoot)) {
							for (const entry of fs.readdirSync(bundlesRoot)) {
								// Only touch semver-looking dirs; keep sibling
								// artefacts like `*.backup` untouched.
								if (!/^\d+\.\d+\.\d+/.test(entry)) continue;
								const target = path.join(bundlesRoot, entry);
								try {
									fs.rmSync(target, { recursive: true, force: true });
								} catch {
									// Best-effort; the retry below will surface a real error if this mattered.
								}
							}
						}
					} catch {
						// Non-fatal — we retry the install regardless.
					}
					installResult = await runInstall();
				}

				if (
					installResult.ok &&
					(installResult.result === "installed" ||
						installResult.result === "upgraded" ||
						installResult.result === "current")
				) {
					const version = installResult.bundle?.version ?? readReceiptVersion();
					steps.push({
						name: "plugin",
						ok: true,
						detail: version ? `${version} installed` : "installed",
					});
					pluginJustInstalled = installResult.result !== "current";
				} else {
					const reasonCode = installResult.error?.code;
					const reasonMessage = installResult.error?.message ?? installResult.result ?? "unknown reason";
					const hint =
						reasonCode === "auth_required" || reasonCode === "renewal_required"
							? "run `agent-memory plugin install` and complete the browser sign-in"
							: "run `agent-memory plugin install --json` for details";
					steps.push({
						name: "plugin",
						ok: false,
						detail: `install failed (${reasonMessage}) — ${hint}`,
					});
				}
			} catch (error) {
				steps.push({
					name: "plugin",
					ok: false,
					detail: `install failed — ${(error as Error).message}`,
				});
			}
		}
	}

	if (skipPlugin) {
		steps.push({ name: "plugin", ok: true, detail: "skipped — core-only setup requested" });
	}

	// Step 5: register the MCP server in every detected local harness (Claude
	// Code, Cursor, Windsurf, Codex). Idempotent — re-running setup after adding
	// a new agent will pick it up. Hooks handle passive injection; MCP is what
	// lets the model pull memory on demand as tools.
	let mcpRegisteredKeys: string[] = [];
	if (!skipMcp) {
		try {
			const results = registerMcpInAgents(null);
			const registered = results.filter((r) => r.status === "registered").map((r) => r.key);
			const already = results.filter((r) => r.status === "already").map((r) => r.key);
			mcpRegisteredKeys = registered;
			let detail: string;
			if (registered.length === 0 && already.length === 0) {
				detail = "no supported agents detected";
			} else if (registered.length === 0) {
				detail = `already registered (${already.join(", ")})`;
			} else if (already.length === 0) {
				detail = `registered (${registered.join(", ")})`;
			} else {
				detail = `registered (${registered.join(", ")}); already (${already.join(", ")})`;
			}
			steps.push({ name: "mcp", ok: true, detail });
		} catch (error) {
			steps.push({ name: "mcp", ok: false, detail: (error as Error).message });
		}
	} else {
		steps.push({ name: "mcp", ok: true, detail: "skipped" });
	}

	if (json) {
		output({ ok: steps.every((step) => step.ok), directory: getMemoryDir(), steps }, true);
		return;
	}

	console.log("");
	console.log(colorize("agent-memory setup", "bold"));
	for (const step of steps) {
		const mark = step.ok ? MARK_OK : MARK_FAIL;
		const detail = step.detail ? colorize(` ${step.detail}`, "dim") : "";
		console.log(`  ${mark} ${step.name}${detail}`);
	}
	console.log("");
	if (mcpRegisteredKeys.length > 0) {
		console.log(colorize(`Restart ${mcpRegisteredKeys.join(", ")} to pick up the new MCP server.`, "dim"));
	}
	await printSetupUsageStats(steps.some((s) => s.name === "plugin" && s.ok));
	console.log(colorize("Setup complete. Your agents will discover memory automatically next session.", "green"));
	console.log(colorize("Your notes stay in plain Markdown on this device — no account, no upload.", "dim"));
	console.log(colorize('Open your agent and ask: "What do you remember about me?"', "cyan"));
	console.log("");
	console.log("Try it now:");
	console.log(`  ${colorize('agent-memory save "your first note"', "cyan")}              — save a note you own`);
	console.log(
		`  ${colorize("agent-memory status", "cyan")}                              — verify everything is healthy`,
	);
	if (pluginJustInstalled) {
		console.log("");
		console.log(colorize("The local plugin is live. Feel the magic now:", "green"));
		console.log(
			`  ${colorize('agent-memory recall "what did we decide about auth?"', "cyan")}   — search past sessions`,
		);
		console.log(
			`  ${colorize("agent-memory learn", "cyan")}                                    — surface repeated corrections`,
		);
		console.log(
			`  ${colorize("agent-memory worker start", "cyan")}                             — capture new sessions in real time`,
		);
		console.log(
			`  ${colorize("agent-memory dashboard", "cyan")}                                — private local dashboard`,
		);
	} else if (skipPlugin) {
		console.log(colorize("Core-only setup selected. Enable session intelligence anytime:", "dim"));
		console.log(
			`  ${colorize("agent-memory plugin install", "cyan")} — recall and learn with a free daily allowance`,
		);
	}
	console.log("");
}

/**
 * Reverse of {@link cmdSetup}: removes every install artifact agent-memory
 * creates outside of this package — hooks, skills, MCP registrations, shell
 * completions, and the Pro plugin executables. Memory data under
 * `getMemoryDir()` (MEMORY.md, daily logs, scratchpad, topics, qmd index) is
 * left untouched unless `--data` is passed, since that's the one step a user
 * can't undo. Destructive by nature, so it always requires either an
 * interactive confirmation or `--yes`.
 */
async function cmdUninstall(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	const yes = hasFlag(flags, "yes");
	const wipeData = hasFlag(flags, "data");
	const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);

	if (!yes) {
		const message = wipeData
			? "Re-run with --yes to remove agent-memory's hooks, skills, MCP registrations, completions, and Pro plugin, and permanently delete ~/.agent-memory (MEMORY.md, daily logs, scratchpad, topics, qmd index)."
			: "Re-run with --yes to remove agent-memory's hooks, skills, MCP registrations, completions, and Pro plugin. Your memory data is left untouched.";
		if (interactive) {
			const question = wipeData
				? "This will also permanently delete your memory data (MEMORY.md, daily logs, scratchpad). Continue?"
				: "Remove agent-memory's hooks, skills, MCP registrations, completions, and Pro plugin?";
			if (!(await promptYesNo(question, false))) {
				console.log("Aborted. Nothing was removed.");
				return;
			}
		} else {
			if (json) output({ ok: false, error: { code: "confirmation_required", message } }, true);
			else console.error(`Error: ${message}`);
			process.exitCode = 1;
			return;
		}
	}

	const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

	try {
		const report = uninstallSkills();
		if (!report.ok) throw new Error(report.error ?? "failed to remove skills");
		steps.push({
			name: "skills",
			ok: true,
			detail: report.removed.length ? `removed ${report.removed.length}` : "not installed",
		});
	} catch (error) {
		steps.push({ name: "skills", ok: false, detail: (error as Error).message });
	}

	try {
		const report = uninstallHooks();
		if (!report.ok) throw new Error(report.error ?? "failed to remove hooks");
		const removed = report.results.filter((r) => r.installed).length;
		steps.push({ name: "hooks", ok: true, detail: removed ? `removed ${removed}` : "not installed" });
	} catch (error) {
		steps.push({ name: "hooks", ok: false, detail: (error as Error).message });
	}

	try {
		const results = unregisterMcpFromAgents(null);
		const removed = results.filter((r) => r.status === "unregistered").length;
		steps.push({ name: "mcp", ok: true, detail: removed ? `unregistered ${removed}` : "not registered" });
	} catch (error) {
		steps.push({ name: "mcp", ok: false, detail: (error as Error).message });
	}

	try {
		const results = uninstallCompletion();
		const removed = results.filter((r) => r.removed || r.profileUpdated).length;
		steps.push({ name: "completions", ok: true, detail: removed ? `removed ${removed}` : "not installed" });
	} catch (error) {
		steps.push({ name: "completions", ok: false, detail: (error as Error).message });
	}

	try {
		const manager = createDefaultPluginBootstrap(VERSION);
		const pluginResult = await manager.uninstall();
		steps.push({ name: "plugin", ok: pluginResult.ok, detail: pluginResult.result });
	} catch (error) {
		steps.push({ name: "plugin", ok: false, detail: (error as Error).message });
	}

	if (wipeData) {
		try {
			const memoryDir = getMemoryDir();
			if (fs.existsSync(memoryDir)) fs.rmSync(memoryDir, { recursive: true, force: true });
			const pluginRoot = getDefaultPluginInstallRoot();
			if (fs.existsSync(pluginRoot)) fs.rmSync(pluginRoot, { recursive: true, force: true });
			steps.push({ name: "data", ok: true, detail: memoryDir });
		} catch (error) {
			steps.push({ name: "data", ok: false, detail: (error as Error).message });
		}
	}

	const allOk = steps.every((step) => step.ok);
	if (!allOk) process.exitCode = 1;

	if (json) {
		output({ ok: allOk, data: wipeData, steps }, true);
		return;
	}

	console.log("");
	console.log(colorize("agent-memory uninstall", "bold"));
	for (const step of steps) {
		const mark = step.ok ? MARK_OK : MARK_FAIL;
		const detail = step.detail ? colorize(` ${step.detail}`, "dim") : "";
		console.log(`  ${mark} ${step.name}${detail}`);
	}
	console.log("");
	if (!allOk) {
		console.log(colorize("Some steps failed — see details above.", "yellow"));
	} else if (wipeData) {
		console.log(colorize("agent-memory has been fully removed, including your memory data.", "green"));
	} else {
		console.log(colorize("agent-memory's install artifacts have been removed.", "green"));
		console.log(
			colorize(`Your notes are untouched at ${getMemoryDir()}. Re-run with --data to remove them too.`, "dim"),
		);
	}
}

/**
 * Explain the optional plugin without making a successful core setup feel
 * incomplete. Keep the quota line here in sync with `freeEntitlement()`.
 */
function printProPitch(mode: "first-run" | "reinstall"): void {
	console.log("");
	if (mode === "reinstall") {
		console.log(`${MARK_WARN} ${colorize("The optional local plugin is not enabled.", "yellow")}`);
		console.log(colorize("  Core memory is already ready. The plugin adds:", "dim"));
	} else {
		console.log(
			`${colorize("Optional: AgentMemory Pro", "bold")} — ${colorize("memory that learns from your work", "dim")}`,
		);
	}
	console.log(
		`  ${colorize("Recall across sessions", "cyan")}   Ask "what did we decide about auth?" across Claude, Codex, Cursor.`,
	);
	console.log(
		`  ${colorize("Learn from corrections", "cyan")}   Turn repeated fixes into memory you can inspect and undo.`,
	);
	console.log(`  ${colorize("Real-time capture", "cyan")}        Local worker indexes new sessions as they happen.`);
	console.log(
		`  ${colorize("Private by default", "cyan")}       Memory and session content stay on this device — no account required.`,
	);
	console.log(
		`  ${colorize("Included at no cost:", "green")} ${colorize("20 recalls + 5 learning scans per day", "bold")}. Local indexing and dashboard remain free.`,
	);
	console.log("");
}

async function cmdStatus(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();
	const dir = getMemoryDir();
	const memFile = getMemoryFile();
	const spFile = getScratchpadFile();
	const dailyDir = getDailyDir();
	const topicsDir = getTopicsDir();

	const memContent = readFileSafe(memFile);
	const spContent = readFileSafe(spFile);

	let dailyCount = 0;
	try {
		dailyCount = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".md")).length;
	} catch {
		// directory may not exist
	}
	let topicCount = 0;
	try {
		topicCount = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).length;
	} catch {
		// directory may not exist
	}

	const qmdFound = await detectQmd();
	let hasCollection = false;
	let health = null;
	let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
	if (qmdFound) {
		hasCollection = await checkCollection();
		if (hasCollection) {
			await ensureQmdAvailableForSync();
			health = await getQmdHealth();
			// A live semantic probe confirms embeddings are actually usable, but
			// it costs a real qmd query (and a possible model load), so it's
			// opt-in — the cheap pending-embed count below covers the common case.
			if (hasFlag(flags, "probe")) {
				embeddings = await probeEmbeddings();
			}
		}
	}

	const embedMode = getQmdEmbedMode();
	let officialPlugin: { installed: boolean; result: string; entitlement: string } = {
		installed: false,
		result: "unavailable",
		entitlement: "missing",
	};
	try {
		const plugin = await createDefaultPluginBootstrap(VERSION).status();
		officialPlugin = {
			installed: Boolean(plugin.bundle),
			result: plugin.result,
			entitlement: plugin.entitlement.state,
		};
	} catch {
		// Commercial status must never make core status fail.
	}

	if (json) {
		output(
			{
				directory: dir,
				memoryFile: {
					exists: memContent !== null,
					chars: memContent?.length ?? 0,
					lines: memContent ? memContent.split("\n").length : 0,
				},
				scratchpadFile: {
					exists: spContent !== null,
					items: spContent ? parseScratchpad(spContent).length : 0,
					openItems: spContent ? parseScratchpad(spContent).filter((i) => !i.done).length : 0,
				},
				dailyLogs: dailyCount,
				topics: topicCount,
				qmd: {
					available: qmdFound,
					collection: hasCollection ? getCollectionName() : null,
					health,
					embeddings,
				},
				embedMode,
				officialPlugin,
			},
			true,
		);
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
		console.log(`Topics: ${topicCount} file(s)`);
		console.log("");
		if (qmdFound) {
			console.log(`qmd: available`);
			console.log(
				`Collection '${getCollectionName()}': ${hasCollection ? "configured" : "not configured — run: agent-memory setup"}`,
			);
			console.log(`Embed mode: ${embedMode}`);
			if (hasCollection && embeddings !== "n/a") {
				const embLabel =
					embeddings === "ready"
						? "ready"
						: embeddings === "missing"
							? "missing — run: agent-memory sync"
							: "unknown (could not verify within probe timeout)";
				console.log(`Embeddings (semantic/deep search): ${embLabel}`);
			}
			if (health) {
				if (health.totalFiles !== null) console.log(`Files indexed: ${health.totalFiles}`);
				if (health.vectorsEmbedded !== null) console.log(`Vectors embedded: ${health.vectorsEmbedded}`);
				if (health.pendingEmbed !== null && health.pendingEmbed > 0) {
					console.log(`Pending embeds: ${health.pendingEmbed}`);
					console.log(`  run: agent-memory sync`);
				}
				if (health.lastUpdated) console.log(`Last updated: ${health.lastUpdated}`);
			}
		} else {
			console.log("qmd: not installed");
		}
		if (!officialPlugin.installed) {
			console.log("");
			console.log("AgentMemory Pro: not installed");
			console.log("  try without an account: agent-memory pro install");
		}
	}
}

interface DoctorRow {
	status: "ok" | "warn" | "fail";
	label: string;
	detail: string;
	fix?: string;
}

function printDoctorRow(row: DoctorRow): void {
	const mark = row.status === "ok" ? MARK_OK : row.status === "warn" ? MARK_WARN : MARK_FAIL;
	console.log(`  ${mark} ${row.label.padEnd(28)} ${colorize(row.detail, "dim")}`);
	if (row.fix) console.log(`      ${colorize(`↳ fix: ${row.fix}`, "cyan")}`);
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	ensureDirs();

	const rows: DoctorRow[] = [];

	// Memory dir
	const dir = getMemoryDir();
	let dirWritable = false;
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		dirWritable = true;
	} catch {
		// noop
	}
	rows.push({
		status: dirWritable ? "ok" : "fail",
		label: "Memory directory",
		detail: dirWritable ? dir : `${dir} — not writable`,
		fix: dirWritable ? undefined : `chmod u+w ${dir}`,
	});

	// MEMORY.md seeded?
	const memContent = readFileSafe(getMemoryFile());
	rows.push({
		status: memContent && memContent.length > 0 ? "ok" : "warn",
		label: "MEMORY.md",
		detail:
			memContent && memContent.length > 0
				? `${memContent.split("\n").length} lines, ${memContent.length} chars`
				: "empty — new sessions will see no long-term context",
		fix:
			memContent && memContent.length > 0
				? undefined
				: 'agent-memory write --target long_term --content "…first fact…"',
	});

	// qmd
	const qmdFound = await detectQmd();
	if (!qmdFound) {
		rows.push({
			status: "warn",
			label: "qmd search index",
			detail: "not installed — keyword/semantic search unavailable",
			fix: "bun install -g https://github.com/tobi/qmd",
		});
	} else {
		const hasCollection = await checkCollection();
		if (!hasCollection) {
			rows.push({
				status: "warn",
				label: "qmd collection",
				detail: `'${getCollectionName()}' not configured`,
				fix: "agent-memory setup",
			});
		} else {
			try {
				await ensureQmdAvailableForSync();
			} catch {
				// noop
			}
			const health = await getQmdHealth();
			const files = health?.totalFiles ?? 0;
			const pending = health?.pendingEmbed ?? 0;
			rows.push({
				status: pending > 0 ? "warn" : "ok",
				label: "qmd search index",
				detail: `${files} files indexed${pending > 0 ? `, ${pending} pending embeds` : ""}`,
				fix: pending > 0 ? "agent-memory sync" : undefined,
			});
		}
	}

	// Skills + hooks per detected host
	const { homeDir, targets } = detectHookAgents();
	const detected = targets.filter((target) => target.detected);
	const hookMode = readHookMode();
	rows.push({
		status: "ok",
		label: "Hook mode",
		detail:
			hookMode === "per-turn"
				? "per-turn (SessionStart stable snapshot + UserPromptSubmit query-scoped recall)"
				: "stable (SessionStart-only, full snapshot every session)",
	});
	if (detected.length === 0) {
		rows.push({
			status: "warn",
			label: "Agent hosts",
			detail: "no supported agents detected (Claude Code, Codex, Cursor, opencode)",
			fix: "install one of the agents first, then: agent-memory install-skills",
		});
	} else {
		rows.push({
			status: "ok",
			label: "Agent hosts detected",
			detail: detected.map((target) => target.label).join(", "),
		});
		for (const target of detected) {
			if (!target.supported) {
				// Skip skill/hook rows for hosts we don't yet integrate with (e.g. pi has its own extension).
				continue;
			}
			const skillPath = homeDir ? `${target.homeMarker}/skills/agent-memory/SKILL.md` : null;
			const skillInstalled = skillPath ? fs.existsSync(skillPath) : false;
			rows.push({
				status: skillInstalled ? "ok" : "warn",
				label: `Skill: ${target.label}`,
				detail: skillInstalled ? "SKILL.md installed" : "SKILL.md missing — agent cannot call memory",
				fix: skillInstalled ? undefined : "agent-memory install-skills",
			});
			const sessionInstalled = homeDir ? isHookInstalled(homeDir, target.key) : false;
			const supportsPerTurn = target.key === "claude" || target.key === "codex";
			// opencode only gets a static instructions file (no command-execution hook API in its
			// plugin surface we could verify) — never report it as a guaranteed-automatic hook.
			const guaranteedAutomatic = target.key !== "opencode";
			const promptInstalled = homeDir && supportsPerTurn ? isUserPromptSubmitInstalled(homeDir, target.key) : false;
			const wantsPerTurn = hookMode === "per-turn" && supportsPerTurn;
			// Stop backs the write side with a periodic memory-write nudge. Claude
			// Code only for now, mode-independent — always wanted when supported.
			const wantsWriteHooks = target.key === "claude";
			const stopInstalled = homeDir && wantsWriteHooks ? isStopHookInstalled(homeDir, target.key) : false;
			const writeHooksOk = !wantsWriteHooks || stopInstalled;
			const ok = sessionInstalled && guaranteedAutomatic && (wantsPerTurn ? promptInstalled : true) && writeHooksOk;
			let detail: string;
			if (!sessionInstalled) {
				detail = "not installed — no automatic context";
			} else if (!guaranteedAutomatic) {
				detail = "static instructions installed — model must run context manually, not guaranteed";
			} else if (!supportsPerTurn) {
				detail = "SessionStart hook active";
			} else if (wantsPerTurn && !promptInstalled) {
				detail = "SessionStart active, UserPromptSubmit missing — per-turn recall disabled";
			} else if (wantsPerTurn) {
				detail = "SessionStart + UserPromptSubmit hooks active";
			} else {
				detail = "SessionStart hook active";
			}
			if (wantsWriteHooks) {
				detail += stopInstalled ? "; Stop memory-write nudge active" : "; Stop memory-write nudge missing";
			}
			rows.push({
				status: ok ? "ok" : "warn",
				label: `Hook: ${target.label}`,
				detail,
				fix: ok ? undefined : `agent-memory install-hooks --mode ${hookMode}`,
			});
		}
	}

	// Pro plugin — emit exactly one row per outcome (bootstrap failure, not installed, or installed).
	let proBootstrapError: string | undefined;
	let proStatus: { installed: boolean; result: string; entitlement: string } | undefined;
	try {
		const plugin = await createDefaultPluginBootstrap(VERSION).status();
		proStatus = {
			installed: Boolean(plugin.bundle),
			result: plugin.result,
			entitlement: plugin.entitlement.state,
		};
	} catch (error) {
		proBootstrapError = error instanceof Error ? error.message : String(error);
	}
	if (proBootstrapError) {
		rows.push({
			status: "fail",
			label: "AgentMemory Pro",
			detail: `bootstrap failed: ${proBootstrapError}`,
			fix: "agent-memory pro install",
		});
	} else if (!proStatus?.installed) {
		rows.push({
			status: "warn",
			label: "AgentMemory Pro",
			detail: "not installed — recall + learn + dashboard unavailable",
			fix: "agent-memory pro install",
		});
	} else {
		rows.push({
			status: "ok",
			label: "AgentMemory Pro",
			detail: `installed (${proStatus.result}, entitlement=${proStatus.entitlement})`,
		});
	}

	if (json) {
		output({ rows }, true);
		if (rows.some((row) => row.status === "fail")) process.exitCode = 1;
		return;
	}

	console.log("");
	console.log(colorize("AgentMemory diagnostic", "bold"));
	console.log("");
	for (const row of rows) printDoctorRow(row);
	console.log("");

	const failed = rows.filter((row) => row.status === "fail").length;
	const warned = rows.filter((row) => row.status === "warn").length;
	if (failed > 0) {
		console.log(colorize(`${failed} issue(s) need attention.`, "red"));
		process.exitCode = 1;
	} else if (warned > 0) {
		console.log(colorize(`${warned} optional improvement(s) available.`, "yellow"));
	} else {
		console.log(colorize("Everything looks healthy.", "green"));
	}
}

async function cmdTutorial(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	if (json) {
		exitError("tutorial is interactive — remove --json to run", true);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		exitError("tutorial requires an interactive terminal", false);
	}
	const os = await import("node:os");
	const originalDir = getMemoryDir();
	const sandboxDir = fs.mkdtempSync(`${os.tmpdir()}/agent-memory-tutorial-`);
	_setBaseDir(sandboxDir);
	try {
		console.log("");
		console.log(colorize("AgentMemory Tutorial (3 minutes)", "bold"));
		console.log(colorize("Everything below runs in a throwaway sandbox — your real memory is untouched.", "dim"));
		console.log(colorize(`Sandbox: ${sandboxDir}`, "dim"));
		console.log("");
		console.log(colorize("Real memory dir stays at:", "dim"), originalDir);
		console.log("");
		await promptEnter("Press Enter to begin.");

		// Step 1: init
		console.log("");
		console.log(colorize("Step 1/4 — init", "bold"));
		console.log("This creates MEMORY.md, SCRATCHPAD.md, daily/ and topics/ in the sandbox.");
		console.log("");
		await promptEnter("Ready? Press Enter to run `agent-memory init --yes`.");
		ensureDirs();
		console.log(`  ${MARK_OK} Sandbox ready at ${sandboxDir}`);

		// Step 2: save
		console.log("");
		console.log(colorize("Step 2/4 — save a memory", "bold"));
		console.log("`save` appends a line to today's log. Try it:");
		console.log("");
		await promptEnter('Press Enter to run `agent-memory save "tutorial: first save"`.');
		await memoryWrite({ target: "daily", content: "tutorial: first save" });
		console.log(`  ${MARK_OK} Saved. Look inside: ${sandboxDir}/daily/`);

		// Step 3: note (scratchpad)
		console.log("");
		console.log(colorize("Step 3/4 — track a follow-up", "bold"));
		console.log("`note` adds a persistent checklist item.");
		console.log("");
		await promptEnter('Press Enter to run `agent-memory note "tutorial: try recall"`.');
		// Direct scratchpad manipulation to keep the demo dep-free
		const spFile = getScratchpadFile();
		const existing = readFileSafe(spFile) ?? "# Scratchpad\n";
		fs.writeFileSync(spFile, `${existing}\n<!-- ${nowTimestamp()} [cli] -->\n- [ ] tutorial: try recall\n`);
		console.log(`  ${MARK_OK} Added a scratchpad item you can complete later.`);

		// Step 4: context
		console.log("");
		console.log(colorize("Step 4/4 — inspect what the agent sees", "bold"));
		console.log("`context` builds the injected context block your agent reads at session start.");
		console.log("");
		await promptEnter("Press Enter to preview the context.");
		const context = buildMemoryContext("");
		const preview = context.split("\n").slice(0, 20).join("\n");
		console.log(colorize("--- context preview (first 20 lines) ---", "dim"));
		console.log(preview);
		console.log(colorize("--- end preview ---", "dim"));

		console.log("");
		console.log(colorize("You're done.", "bold"));
		console.log("");
		console.log("In your real setup:");
		console.log("  agent-memory setup                 — one-shot install: memory dir, skills, hooks, MCP");
		console.log('  agent-memory save "your note"      — quick save');
		console.log('  agent-memory note "your todo"      — scratchpad item');
		console.log("  agent-memory doctor                — health check");
		console.log("");
		if (await promptYesNo("Remove the sandbox directory now?", true)) {
			try {
				fs.rmSync(sandboxDir, { recursive: true, force: true });
				console.log(`  ${MARK_OK} Sandbox removed.`);
			} catch (error) {
				console.log(
					colorize(
						`  Could not remove sandbox: ${error instanceof Error ? error.message : String(error)}`,
						"yellow",
					),
				);
			}
		} else {
			console.log(`  Sandbox preserved: ${sandboxDir}`);
		}
	} finally {
		_setBaseDir(originalDir);
	}
}

async function promptEnter(prompt: string): Promise<void> {
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		await rl.question(`${colorize(prompt, "cyan")} `);
	} finally {
		rl.close();
	}
}

async function cmdDistil(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const dryRun = hasFlag(flags, "dry-run");

	const result = await distilMemories({ dryRun });

	if (json) {
		output(result, true);
	} else {
		if (result.totalEntries === 0) {
			console.log(result.output.trim());
			return;
		}
		if (dryRun) {
			console.log("--- Dry run (MEMORY.md not modified) ---\n");
		}
		console.log(result.output.trim());
		console.log("");
		console.log(
			`Distilled ${result.totalEntries} entries from ${result.totalDailyFiles} daily file(s) and ${result.totalTopicFiles} topic file(s), ${result.totalTags} tag(s).`,
		);
		if (!dryRun) {
			console.log("MEMORY.md updated.");
		}
	}
}

function printPluginUsage(): void {
	console.log(`agent-memory plugin — optional official plugins

Usage:
  agent-memory plugin [list]
  agent-memory plugin status
  agent-memory plugin install [--channel stable] [--no-browser]
  agent-memory plugin update [--channel stable]
  agent-memory plugin uninstall --yes
  agent-memory plugin manage [--no-browser]

The public core remains fully usable without AgentMemory Pro. Install uses a random
installation identifier and requires no account or email. The free tier includes
20 recalls and 5 learning scans per local day; indexing and the Memory Dashboard
remain available. Memory and session content stay on this device.`);
}

function pluginCommandFailure(command: string, error: unknown): PluginBootstrapResultV1 {
	return {
		schemaVersion: 1,
		command: `plugin.${command}`,
		ok: false,
		result: "unavailable",
		bundle: null,
		entitlement: {
			plan: null,
			state: "missing",
			features: [],
			capabilities: {},
		},
		nextAction: null,
		error: {
			code: error instanceof PluginBootstrapFailure ? error.code : "plugin_command_failed",
			message: error instanceof Error ? error.message : String(error),
			...(error instanceof PluginBootstrapFailure && error.retryable ? { retryable: true } : {}),
		},
	};
}

async function cmdPlugin(
	flags: Record<string, string | boolean>,
	positional: string[],
): Promise<PluginBootstrapResultV1 | null> {
	const json = hasFlag(flags, "json");
	const subcommand = positional[0] ?? "list";
	if (subcommand === "help" || hasFlag(flags, "help")) {
		printPluginUsage();
		return null;
	}
	const channel = getFlag(flags, "channel") ?? "stable";
	if (channel !== "stable") {
		const failure = pluginCommandFailure(
			subcommand,
			new PluginBootstrapFailure("channel_invalid", "--channel supports only 'stable'"),
		);
		printPluginResult(failure, json, false);
		return failure;
	}
	const allowBrowser = !json && !hasFlag(flags, "no-browser") && Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const manager = createDefaultPluginBootstrap(VERSION);

	let result: PluginBootstrapResultV1;
	try {
		switch (subcommand) {
			case "list":
				result = await manager.list();
				break;
			case "status":
				result = await manager.status(channel);
				break;
			case "install":
				result = await manager.install({ channel, allowAuthentication: allowBrowser });
				break;
			case "update":
				result = await manager.update({ channel, allowAuthentication: false });
				break;
			case "uninstall":
				if (!hasFlag(flags, "yes")) {
					const status = await manager.status(channel);
					result = {
						...status,
						command: "plugin.uninstall",
						ok: false,
						result: "unavailable",
						error: {
							code: "confirmation_required",
							message: "Re-run with --yes to remove AgentMemory Pro executable components",
						},
					};
					break;
				}
				result = await manager.uninstall();
				break;
			case "manage":
				result = await manager.manage();
				break;
			default:
				result = pluginCommandFailure(
					subcommand,
					new PluginBootstrapFailure(
						"unknown_plugin_command",
						`Unknown plugin command: ${subcommand}. Available bootstrap commands: list, status, install, update, uninstall, manage.`,
					),
				);
		}
	} catch (error) {
		result = pluginCommandFailure(subcommand, error);
	}
	printPluginResult(result, json, allowBrowser && (subcommand === "install" || subcommand === "manage"));
	return result;
}

async function printFirstRunProof(): Promise<void> {
	try {
		const result = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).run("index", {
			args: [],
			flags: {},
			signal: new AbortController().signal,
		});
		if (!result?.ok || !result.data || typeof result.data !== "object") return;
		const stats = (result.data as { stats?: { discovered?: Record<string, number>; selected?: number } }).stats;
		if (!stats?.discovered) return;
		const hosts = [
			["Claude Code", stats.discovered.claude ?? 0],
			["Codex", stats.discovered.codex ?? 0],
			["Pi", stats.discovered.pi ?? 0],
		] as const;
		console.log("");
		console.log("Found local coding history:");
		for (const [label, count] of hosts) console.log(`  ${label.padEnd(13)} ${count} sessions`);
		console.log("");
		console.log(`${stats.selected ?? 0} sessions available for local recall. Nothing was uploaded.`);
		console.log("");
		console.log('Try: agent-memory recall "what did we decide about authentication?"');
		console.log("Open: agent-memory dashboard");
	} catch {
		// Personalized proof is helpful but must never turn a successful install into a failure.
	}
}

const PRO_PREVIEW_DAILY_SESSION_CAP = 50;
const PRO_PREVIEW_DISCOVERY_FILE_CAP = 10_000;

type PreviewHost = "claude" | "codex" | "pi";

interface PreviewSessionSummary {
	available: boolean;
	sessions: Record<PreviewHost, number>;
	discovered: number;
	previewed: number;
	cap: {
		limit: number;
		used: number;
		remaining: number;
		resetAt: string;
		exhausted: boolean;
	};
}

function previewSessionRoots(): Record<PreviewHost, string> {
	return {
		claude: process.env.AGENT_MEMORY_CLAUDE_SESSION_ROOT ?? path.join(os.homedir(), ".claude", "projects"),
		codex: process.env.AGENT_MEMORY_CODEX_SESSION_ROOT ?? path.join(os.homedir(), ".codex", "sessions"),
		pi: process.env.AGENT_MEMORY_PI_SESSION_ROOT ?? path.join(os.homedir(), ".pi", "agent", "sessions"),
	};
}

function localDayKey(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function nextLocalMidnight(now = new Date()): string {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

function previewUsagePath(): string {
	return path.join(
		process.env.AGENT_MEMORY_PLUGIN_DIR ?? path.join(os.homedir(), ".agent-memory", "system", "plugins"),
		"state",
		"pro-preview-usage.json",
	);
}

function countSessionFiles(root: string, cap: number): number {
	if (!fs.existsSync(root)) return 0;
	let count = 0;
	const stack = [root];
	while (stack.length && count < cap) {
		const directory = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile()) {
				count++;
				if (count >= cap) break;
			}
		}
	}
	return count;
}

function reserveProPreviewSessions(discovered: number): { cap: PreviewSessionSummary["cap"]; consumed: number } {
	const now = new Date();
	const date = localDayKey(now);
	const filePath = previewUsagePath();
	let used = 0;
	try {
		const existing = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { date?: unknown; used?: unknown };
		if (existing.date === date && Number.isSafeInteger(existing.used)) used = Math.max(0, Number(existing.used));
	} catch {
		// Missing or corrupt preview usage starts a fresh local day window.
	}
	const remainingBefore = Math.max(0, PRO_PREVIEW_DAILY_SESSION_CAP - used);
	const consumed = Math.min(discovered, remainingBefore);
	const nextUsed = used + consumed;
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			filePath,
			`${JSON.stringify({ schemaVersion: 1, date, used: nextUsed, updatedAt: now.toISOString() }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// Preview metering is best-effort and local only; never block the preview.
	}
	return {
		consumed,
		cap: {
			limit: PRO_PREVIEW_DAILY_SESSION_CAP,
			used: nextUsed,
			remaining: Math.max(0, PRO_PREVIEW_DAILY_SESSION_CAP - nextUsed),
			resetAt: nextLocalMidnight(now),
			exhausted: remainingBefore === 0 && discovered > 0,
		},
	};
}

function scanProPreviewSessions(): PreviewSessionSummary {
	const roots = previewSessionRoots();
	const sessions: Record<PreviewHost, number> = { claude: 0, codex: 0, pi: 0 };
	for (const host of Object.keys(roots) as PreviewHost[]) {
		sessions[host] = countSessionFiles(roots[host], PRO_PREVIEW_DISCOVERY_FILE_CAP);
	}
	const discovered = sessions.claude + sessions.codex + sessions.pi;
	const { cap, consumed } = reserveProPreviewSessions(discovered);
	const previewed = Math.min(discovered, consumed);
	return { available: discovered > 0 && previewed > 0, sessions, discovered, previewed, cap };
}

async function cmdProPreview(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	const preview = scanProPreviewSessions();
	if (json) output(preview, true);
	else renderProPreview(preview);
}

function renderProPreview(preview: PreviewSessionSummary): void {
	if (!preview.discovered) {
		console.log("No local coding history found yet. Try running a session in Claude Code or Codex first.");
		console.log("Then re-run: agent-memory pro preview");
		return;
	}
	if (preview.cap.exhausted) {
		console.log("");
		console.log(`Daily preview cap reached (${preview.cap.used}/${preview.cap.limit} sessions).`);
		console.log(`Resets at ${preview.cap.resetAt}.`);
		console.log("");
		console.log("Install to make your local history searchable:");
		console.log("  agent-memory pro install");
		return;
	}
	console.log("");
	console.log(
		colorize(
			`  ${preview.previewed.toLocaleString("en-US")} of ${preview.discovered.toLocaleString("en-US")} local sessions previewed (nothing uploaded).`,
			"bold",
		),
	);
	console.log("");
	console.log(`  ${MARK_OK} Claude Code    ${preview.sessions.claude.toLocaleString("en-US")}`);
	console.log(`  ${MARK_OK} Codex          ${preview.sessions.codex.toLocaleString("en-US")}`);
	if (preview.sessions.pi > 0) {
		console.log(`  ${MARK_OK} Pi             ${preview.sessions.pi.toLocaleString("en-US")}`);
	}
	console.log("");
	console.log(
		`Daily preview cap: ${preview.cap.used}/${preview.cap.limit} sessions used, ${preview.cap.remaining} remaining.`,
	);
	console.log("");
	console.log("Install to make all of it searchable:");
	console.log("  agent-memory pro install");
	console.log("");
	console.log(colorize("No account. No email. Free preview starts now.", "dim"));
}

async function cmdPro(flags: Record<string, string | boolean>, positional: string[]): Promise<void> {
	const subcommand = positional[0];
	if (!subcommand) {
		await cmdPlugin(flags, ["list"]);
		return;
	}
	if (subcommand === "preview") {
		await cmdProPreview(flags);
		return;
	}
	const mapped = subcommand === "upgrade" ? "update" : subcommand;
	if (!["install", "status", "update", "manage"].includes(mapped)) {
		const json = hasFlag(flags, "json");
		const message = `Unknown Pro command: ${subcommand}. Available commands: install, preview, status, upgrade, manage.`;
		if (json) console.log(JSON.stringify({ error: message }));
		else console.error(`Error: ${message}`);
		process.exitCode = 1;
		return;
	}
	const result = await cmdPlugin(flags, [mapped]);
	if (!hasFlag(flags, "json") && mapped === "install" && ["installed", "upgraded"].includes(result?.result ?? ""))
		await printFirstRunProof();
}

// ---------------------------------------------------------------------------
// Upgrade (CLI + Pro plugin bundle)
// ---------------------------------------------------------------------------

async function readPluginCurrentVersion(): Promise<string | null> {
	try {
		const manager = createDefaultPluginBootstrap(VERSION);
		const status = await manager.status("stable");
		return status.bundle?.version ?? null;
	} catch {
		return null;
	}
}

async function resolvePluginLatestHint(): Promise<{
	latest: string | null;
	updateAvailable: boolean;
	result?: PluginBootstrapResultV1;
}> {
	try {
		const manager = createDefaultPluginBootstrap(VERSION);
		const status = await manager.status("stable");
		// `status.result === "update_available"` means the release feed advertises
		// a newer signed release. `bundle.version` always reflects the *installed*
		// version, so we cannot report the new version number from this call —
		// only the fact that an upgrade exists. `checkForUpgrades` treats
		// `latest == null` + explicit `pluginUpgradeAvailable` accordingly.
		const updateAvailable = status.result === "update_available";
		return {
			latest: updateAvailable ? null : (status.bundle?.version ?? null),
			updateAvailable,
			result: status,
		};
	} catch {
		return { latest: null, updateAvailable: false };
	}
}

async function cmdUpgrade(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	const quiet = hasFlag(flags, "quiet");
	const checkOnly = hasFlag(flags, "check");
	const refresh = hasFlag(flags, "refresh");
	const onlyCli = hasFlag(flags, "cli");
	const onlyPlugin = hasFlag(flags, "plugin");
	const targetCli = onlyCli || !onlyPlugin;
	const targetPlugin = onlyPlugin || !onlyCli;
	const applyAll = hasFlag(flags, "yes") || !process.stdin.isTTY || !process.stdout.isTTY;

	const pluginCurrent = await readPluginCurrentVersion();
	const pluginProbe = targetPlugin ? await resolvePluginLatestHint() : { latest: null, updateAvailable: false };

	const status = await checkForUpgrades({
		cliCurrent: VERSION,
		pluginCurrent,
		refresh,
		pluginLatestHint: pluginProbe.latest,
		pluginUpgradeAvailable: pluginProbe.updateAvailable,
	});

	if (checkOnly) {
		if (json) output(status, true);
		else if (!quiet) printUpgradeStatus(status, { targetCli, targetPlugin });
		return;
	}

	const cliNeedsUpgrade = targetCli && status.cli.upgradeAvailable;
	const pluginNeedsUpgrade = targetPlugin && status.plugin.upgradeAvailable;

	if (!cliNeedsUpgrade && !pluginNeedsUpgrade) {
		if (json) output({ ...status, action: "noop" }, true);
		else if (!quiet) {
			console.log(`agent-memory ${VERSION} is up to date${pluginCurrent ? ` (Pro ${pluginCurrent})` : ""}.`);
		}
		return;
	}

	if (!applyAll) {
		if (!quiet) printUpgradeStatus(status, { targetCli, targetPlugin });
		const confirmed = await promptYesNo("Install available upgrades now?", true);
		if (!confirmed) {
			if (json) output({ ...status, action: "aborted" }, true);
			else console.log("Upgrade cancelled.");
			return;
		}
	}

	const actions: Array<{ target: "cli" | "plugin"; ok: boolean; detail: string }> = [];

	if (cliNeedsUpgrade) {
		const method = detectInstallMethod();
		if (!quiet) console.log(`Upgrading CLI via: ${method.command.join(" ")}`);
		const result = runInstaller(method);
		actions.push({
			target: "cli",
			ok: result.ok,
			detail: result.ok
				? `CLI upgraded to ${status.cli.latest ?? "latest"}`
				: (result.stderr || result.stdout || `exit ${result.code}`).trim(),
		});
	}

	if (pluginNeedsUpgrade) {
		if (!quiet) console.log("Upgrading Pro plugin bundle…");
		const pluginResult = await cmdPlugin({ json: json ? true : "" }, ["update"]);
		const ok = Boolean(pluginResult?.ok);
		actions.push({
			target: "plugin",
			ok,
			detail: ok
				? `Pro upgraded to ${status.plugin.latest ?? "latest"}`
				: (pluginResult?.error?.message ?? "plugin update failed"),
		});
	}

	const allOk = actions.every((entry) => entry.ok);
	if (json) output({ ...status, actions, ok: allOk }, true);
	else if (!quiet) {
		for (const entry of actions) console.log(`  ${entry.ok ? MARK_OK : MARK_FAIL} ${entry.detail}`);
	}
	if (!allOk) process.exitCode = 1;
}

function printUpgradeStatus(status: UpgradeStatus, scope: { targetCli: boolean; targetPlugin: boolean }): void {
	const lines: string[] = [];
	if (scope.targetCli) {
		const marker = status.cli.upgradeAvailable ? MARK_WARN : MARK_OK;
		const target = status.cli.latest ?? "unknown";
		lines.push(
			`  ${marker} CLI       ${status.cli.current} → ${target}${status.cli.upgradeAvailable ? " (upgrade available)" : ""}`,
		);
	}
	if (scope.targetPlugin) {
		const current = status.plugin.current ?? "not installed";
		const target = status.plugin.latest ?? "unknown";
		const marker = status.plugin.upgradeAvailable ? MARK_WARN : MARK_OK;
		lines.push(
			`  ${marker} Pro       ${current} → ${target}${status.plugin.upgradeAvailable ? " (upgrade available)" : ""}`,
		);
	}
	console.log(`Checked ${status.checkedAt}${status.fromCache ? " (cached)" : ""}`);
	for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------------------
// Serve (MCP)
// ---------------------------------------------------------------------------

type McpAgentKey = "claude" | "cursor" | "windsurf" | "codex";
type McpRegistrationEntry = {
	key: McpAgentKey;
	displayName: string;
	path: string;
	status: "registered" | "already" | "not-installed";
};

/**
 * Register the `agent-memory` MCP server across every supported local harness.
 * Idempotent: existing entries are preserved, missing agent dirs are reported
 * as `not-installed` rather than treated as an error. Returns a structured
 * result so both `serve --register` and `setup` can format it their own way.
 */
function registerMcpInAgents(only: Set<string> | null): McpRegistrationEntry[] {
	const home = os.homedir();
	const mcpEntry = { type: "stdio", command: "agent-memory", args: ["serve", "--mcp"] };
	const want = (key: string) => !only || only.has(key);
	const results: McpRegistrationEntry[] = [];

	const registerJson = (key: McpAgentKey, displayName: string, detectPaths: string[], configFile: string): void => {
		const p = path.join(home, configFile);
		const detected = detectPaths.some((rel) => fs.existsSync(path.join(home, rel)));
		if (!detected) {
			results.push({ key, displayName, path: p, status: "not-installed" });
			return;
		}
		let s: Record<string, unknown> = {};
		try {
			s = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		} catch {}
		const servers = (s.mcpServers ?? {}) as Record<string, unknown>;
		if (servers["agent-memory"]) {
			results.push({ key, displayName, path: p, status: "already" });
			return;
		}
		servers["agent-memory"] = mcpEntry;
		s.mcpServers = servers;
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
		results.push({ key, displayName, path: p, status: "registered" });
	};

	// Claude Code stores user-level MCP servers in ~/.claude.json (top-level
	// `mcpServers` key), NOT in ~/.claude/settings.json. The settings file
	// holds hooks/permissions/env — Claude Code does not read MCP config from
	// there. Detect either the `.claude/` dir or `.claude.json` file so we
	// register whenever the user has Claude Code installed at all.
	if (want("claude")) registerJson("claude", "Claude Code", [".claude", ".claude.json"], ".claude.json");
	if (want("cursor")) registerJson("cursor", "Cursor", [".cursor"], ".cursor/mcp.json");
	if (want("windsurf")) registerJson("windsurf", "Windsurf", [".windsurf"], ".windsurf/mcp_settings.json");

	if (want("codex")) {
		const p = path.join(home, ".codex", "config.toml");
		if (!fs.existsSync(p)) {
			results.push({ key: "codex", displayName: "Codex", path: p, status: "not-installed" });
		} else {
			const existing = fs.readFileSync(p, "utf8");
			if (existing.includes("[mcp_servers.agent-memory]")) {
				results.push({ key: "codex", displayName: "Codex", path: p, status: "already" });
			} else {
				const block = '\n[mcp_servers.agent-memory]\ncommand = "agent-memory"\nargs = ["serve", "--mcp"]\n';
				fs.writeFileSync(p, existing.trimEnd() + block, "utf8");
				results.push({ key: "codex", displayName: "Codex", path: p, status: "registered" });
			}
		}
	}

	return results;
}

type McpUnregistrationEntry = {
	key: McpAgentKey;
	displayName: string;
	path: string;
	status: "unregistered" | "not-registered" | "not-installed";
};

/**
 * Reverse of {@link registerMcpInAgents}: removes the `agent-memory` MCP server
 * entry from every supported local harness. Missing config files are reported
 * as `not-installed`, files that never had the entry as `not-registered`.
 */
function unregisterMcpFromAgents(only: Set<string> | null): McpUnregistrationEntry[] {
	const home = os.homedir();
	const want = (key: string) => !only || only.has(key);
	const results: McpUnregistrationEntry[] = [];

	const unregisterJson = (key: McpAgentKey, displayName: string, configFile: string): void => {
		const p = path.join(home, configFile);
		if (!fs.existsSync(p)) {
			results.push({ key, displayName, path: p, status: "not-installed" });
			return;
		}
		let s: Record<string, unknown> = {};
		try {
			s = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		} catch {}
		const servers = (s.mcpServers ?? {}) as Record<string, unknown>;
		if (!servers["agent-memory"]) {
			results.push({ key, displayName, path: p, status: "not-registered" });
			return;
		}
		delete servers["agent-memory"];
		if (Object.keys(servers).length === 0) delete s.mcpServers;
		else s.mcpServers = servers;
		fs.writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
		results.push({ key, displayName, path: p, status: "unregistered" });
	};

	if (want("claude")) unregisterJson("claude", "Claude Code", ".claude.json");
	if (want("cursor")) unregisterJson("cursor", "Cursor", ".cursor/mcp.json");
	if (want("windsurf")) unregisterJson("windsurf", "Windsurf", ".windsurf/mcp_settings.json");

	if (want("codex")) {
		const p = path.join(home, ".codex", "config.toml");
		if (!fs.existsSync(p)) {
			results.push({ key: "codex", displayName: "Codex", path: p, status: "not-installed" });
		} else {
			const existing = fs.readFileSync(p, "utf8");
			if (!existing.includes("[mcp_servers.agent-memory]")) {
				results.push({ key: "codex", displayName: "Codex", path: p, status: "not-registered" });
			} else {
				const pattern = /\n?\[mcp_servers\.agent-memory\]\n(?:(?!\[)[^\n]*\n?)*/;
				fs.writeFileSync(p, existing.replace(pattern, ""), "utf8");
				results.push({ key: "codex", displayName: "Codex", path: p, status: "unregistered" });
			}
		}
	}

	return results;
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
	const isMcp = hasFlag(flags, "mcp");
	const isRegister = hasFlag(flags, "register");

	if (isRegister) {
		const only = getFlag(flags, "only");
		const onlySet = only ? new Set(only.split(",").map((s) => s.trim())) : null;
		const results = registerMcpInAgents(onlySet);
		const shown = onlySet ? results : results.filter((r) => r.status !== "not-installed");
		for (const r of shown) {
			if (r.status === "already") console.log(`  ${r.displayName}: already registered`);
			else if (r.status === "registered") console.log(`  ${r.displayName}: registered (${r.path})`);
			else console.log(`  ${r.displayName}: not installed`);
		}
		const anyRegistered = results.some((r) => r.status === "registered");
		const anyDetected = results.some((r) => r.status !== "not-installed");
		if (anyRegistered) {
			console.log("");
			console.log("Restart the agent(s) above for the change to take effect.");
		} else if (!onlySet && !anyDetected) {
			console.log("No supported agents detected (Claude Code, Cursor, Windsurf, Codex).");
			console.log("Use --only <agent> to force: --only claude,cursor,windsurf,codex");
		}
		return;
	}

	if (!isMcp) {
		console.log("Usage: agent-memory serve --mcp");
		console.log("       agent-memory serve --register           (register in all detected agents)");
		console.log("       agent-memory serve --register --only claude,cursor,windsurf,codex");
		console.log("");
		console.log("Supported agents: Claude Code, Cursor, Windsurf, Codex");
		console.log("Tip: run --register once, then restart the agent(s).");
		return;
	}

	const server = new StdioMcpServer(VERSION);

	// Core tools: free tier, available without Pro.
	server.addTool(
		{
			name: "memory_read",
			description:
				"Read ONLY the curated long-term memory (MEMORY.md) and open scratchpad items — a small saved snapshot, not a search. For finding things in daily logs/topics, or recalling past chat sessions, use the `agent-memory` skill (search/recall commands) instead of this tool.",
			inputSchema: { type: "object", properties: {} },
		},
		async () => {
			const memFile = getMemoryFile();
			const scratchFile = getScratchpadFile();
			const memory =
				redactSecrets(readFileSafe(memFile) ?? "").content ||
				'(empty — this only covers what was explicitly saved. For things said in prior chat sessions, try `agent-memory recall "<query>"` or the `session_recall`/`session_search` MCP tools, if AgentMemory Pro is installed.)';
			const scratchRaw = readFileSafe(scratchFile) ?? "";
			const scratchItems = parseScratchpad(scratchRaw)
				.filter((item) => !item.done)
				.map((item) => `- [ ] ${redactSecrets(item.text).content}`);
			return [
				"## Long-term memory (MEMORY.md)",
				memory,
				"",
				"## Open scratchpad items",
				scratchItems.length ? scratchItems.join("\n") : "(none)",
			].join("\n");
		},
	);

	server.addTool(
		{
			name: "memory_write",
			description:
				"Append a new entry to memory. Use target='daily' for session notes, 'long_term' for durable facts.",
			inputSchema: {
				type: "object",
				properties: {
					content: { type: "string", description: "Text to store" },
					target: { type: "string", description: "Where to write", enum: ["daily", "long_term", "scratchpad"] },
				},
				required: ["content"],
			},
		},
		async (input) => {
			const content = typeof input.content === "string" ? input.content.trim() : "";
			const target = typeof input.target === "string" ? input.target : "daily";
			if (!content) return "Error: content is required";
			if (target === "scratchpad") {
				const result = await scratchpadAction({ action: "add", text: content, sessionId: "mcp-serve" });
				return result.text;
			}
			await memoryWrite({ target: target as "daily" | "long_term", content, sessionId: "mcp-serve" });
			return `Written to ${target} memory.`;
		},
	);

	// Load Pro plugin and let it register additional MCP tools + startup hooks.
	const runtime = new InstalledPluginRuntimeV1({ coreVersion: VERSION });
	try {
		await runtime.load();
		for (const tool of runtime.getMcpTools()) {
			server.addTool({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, (input) =>
				runtime.runMcpTool(tool.name, input),
			);
		}
		server.addStartupHook(() => runtime.runMcpStartup());
	} catch {
		// Pro not installed or failed to load — serve with core tools only.
	}

	await server.start();
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
	const groups: Array<[string, string[]]> = [
		["Do things", ["save", "note", "recall", "search"]],
		["See things", ["status", "doctor", "dashboard"]],
		["Advanced", ["write", "read", "context", "scratchpad", "distil", "sync"]],
		["Setup", ["setup", "install-skills", "install-hooks", "completion", "uninstall"]],
		["Pro", ["pro", "learn"]],
	];

	const knownGroupCommands = new Set(groups.flatMap(([, list]) => list));
	const otherCommands = COMMANDS.filter((command) => !knownGroupCommands.has(command));
	if (otherCommands.length > 0) groups.push(["Other", [...otherCommands]]);

	const allCommands = groups.flatMap(([, list]) => list);
	const width = Math.max(...allCommands.map((command) => command.length));

	const sections = groups
		.map(([title, list]) => {
			const rows = list
				.filter((command) => COMMAND_DESCRIPTIONS[command as (typeof COMMANDS)[number]])
				.map((command) => {
					const description = COMMAND_DESCRIPTIONS[command as (typeof COMMANDS)[number]];
					return `  ${command.padEnd(width)}  ${description}`;
				})
				.join("\n");
			return `${title}:\n${rows}`;
		})
		.join("\n\n");

	console.log(`agent-memory — persistent memory for coding agents

Usage:
  agent-memory <command> [options]

${sections}

Global flags:
  --dir <path>   Override memory directory
  --json         Machine-readable JSON output

Get started:
  agent-memory setup             — one-shot idempotent installer (recommended)
  agent-memory save "your note"  — quick save to today's log
  agent-memory recall "what did we decide about X?"  — search prior sessions
  agent-memory status            — one-page health readout

New here? Run: ${colorize("agent-memory setup", "cyan")}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Pre-parse content-taking aliases (`save`, `note`) before the general flag parser
// consumes tokens that were meant to be literal user text. Extracts only known
// infrastructure flags — `--json`, `--dir <path>`, and `--target <val>` for `save` —
// and treats the rest of argv as the content string.
function extractRawContentAlias(
	argv: string[],
): { command: "save" | "note"; content: string; flags: Record<string, string | boolean> } | null {
	if (argv.length === 0) return null;
	const command = argv[0];
	if (command !== "save" && command !== "note") return null;
	// Never treat reserved flags as content — they must fall through to the normal
	// parser so `save --help` renders help and `save --json` sets JSON mode without
	// accidentally saving "--help" or "--json" as a daily-log entry.
	if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")) {
		return null;
	}
	const flags: Record<string, string | boolean> = {};
	const contentParts: string[] = [];
	const validValueFlags = new Set(["--dir", "--target"]);
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			flags.json = true;
			continue;
		}
		if (validValueFlags.has(arg) && i + 1 < argv.length) {
			flags[arg.slice(2)] = argv[i + 1];
			i++;
			continue;
		}
		contentParts.push(arg);
	}
	return { command, content: contentParts.join(" ").trim(), flags };
}

async function main() {
	const rawArgv = process.argv.slice(2);
	const rawAlias = extractRawContentAlias(rawArgv);
	const { command, flags, positional } = rawAlias
		? { command: rawAlias.command, flags: rawAlias.flags, positional: [rawAlias.content].filter(Boolean) }
		: parseArgs(rawArgv);
	const json = hasFlag(flags, "json");

	// Reject unknown commands / flags with a helpful "did you mean" hint.
	// Plugin-provided commands fall through and are validated by the runtime.
	validateCommand(command);
	validateFlags(command, positional, flags);

	// Apply --dir override
	const dir = getFlag(flags, "dir");
	if (dir) {
		_setBaseDir(dir);
	}

	// First-run detection: nudge new users toward `init` before they run anything
	// destructive/creative. Gated on the memory *directory* (not MEMORY.md) so a
	// user who intentionally cleared their memory files doesn't get the wizard on
	// every subsequent command. TTY-only; skip introspection commands.
	if (
		process.stdin.isTTY &&
		process.stdout.isTTY &&
		!json &&
		command &&
		!["init", "help", "version", "doctor", "status", "completion", "hook", "serve", "uninstall"].includes(command) &&
		!fs.existsSync(getMemoryDir())
	) {
		console.log(colorize("It looks like this is your first run — no memory directory yet.", "yellow"));
		if (await promptYesNo("Run agent-memory init to set things up?", true)) {
			await cmdInit({});
			console.log("");
			console.log(colorize(`Now continuing with: agent-memory ${command}`, "dim"));
			console.log("");
		}
	}

	if (command === "version" || hasFlag(flags, "version")) {
		output(json ? { version: VERSION } : VERSION, json);
		return;
	}

	// Per-command help: `agent-memory <cmd> --help` shows only that command's usage,
	// flags, and examples. Falls back to the top-level overview when no command was
	// specified. Plugin subcommands render their own help via the plugin runtime.
	if (command === "help") {
		const target = positional[0];
		if (target) {
			console.log(renderCommandHelp(target));
		} else {
			printUsage();
		}
		return;
	}
	if (hasFlag(flags, "help") && command !== "plugin") {
		if (!command) {
			printUsage();
		} else {
			console.log(renderCommandHelp(command));
		}
		return;
	}
	if (!command) {
		printUsage();
		return;
	}

	switch (command) {
		case "context":
			await cmdContext(flags);
			break;
		case "write": {
			// Accept content as the first positional so `write "text"` mirrors
			// `save "text"` / `note "text"`. `--content` still works for scripts
			// and existing callers.
			const positionalContent = positional[0];
			await cmdWrite(
				positionalContent && !getFlag(flags, "content") ? { ...flags, content: positionalContent } : flags,
			);
			break;
		}
		case "save": {
			const text = positional[0] ?? "";
			if (!text) exitError('save requires content: agent-memory save "your note here"', json);
			await cmdWrite({ ...flags, content: text, target: getFlag(flags, "target") ?? "daily" });
			break;
		}
		case "note": {
			const text = positional[0] ?? "";
			if (!text) exitError('note requires text: agent-memory note "your item"', json);
			await cmdScratchpad({ ...flags, text }, ["add"]);
			break;
		}
		case "read":
			await cmdRead(flags);
			break;
		case "scratchpad":
			await cmdScratchpad(flags, positional);
			break;
		case "search":
			await cmdSearch(flags);
			break;
		case "install-skills":
			cmdInstallSkills(flags);
			break;
		case "uninstall-skills":
			cmdInstallSkills({ ...flags, uninstall: true });
			break;
		case "distil":
		case "distill":
			await cmdDistil(flags);
			break;
		case "sync":
			await cmdSync(flags);
			break;
		case "init":
			await cmdInit(flags);
			break;
		case "setup":
			await cmdSetup(flags);
			break;
		case "status":
			await cmdStatus(flags);
			break;
		case "doctor":
			await cmdDoctor(flags);
			break;
		case "tutorial":
			await cmdTutorial(flags);
			break;
		case "completion":
			cmdCompletion(flags, positional);
			break;
		case "install-hooks":
			await cmdInstallHooks(flags);
			break;
		case "uninstall-hooks":
			cmdUninstallHooks(flags);
			break;
		case "uninstall":
			await cmdUninstall(flags);
			break;
		case "hook": {
			const sub = positional[0];
			if (sub !== "session-start" && sub !== "user-prompt-submit" && sub !== "stop") {
				exitError("hook requires 'session-start', 'user-prompt-submit', or 'stop'", json);
			}
			const agent = getFlag(flags, "agent");
			if (!agent) exitError(`hook ${sub} requires --agent`, json);
			if (sub === "user-prompt-submit") {
				await cmdUserPromptSubmit(flags);
				break;
			}
			if (sub === "stop") {
				await cmdStop(flags);
				break;
			}
			// In per-turn mode, SessionStart emits only the stable layer (MEMORY.md + scratchpad).
			// The dynamic layer (daily logs + search) is emitted per-turn by UserPromptSubmit.
			// In stable mode, SessionStart emits the full context (current behavior).
			const layer = readHookMode() === "per-turn" ? "stable" : undefined;
			await cmdContext(layer ? { "no-search": true, layer } : { "no-search": true });
			try {
				const cache = readUpgradeCache();
				if (cache) {
					const status = await checkForUpgrades({
						cliCurrent: VERSION,
						pluginCurrent: cache.pluginCurrent,
						cacheOnly: true,
					});
					const notice = formatUpgradeNotice(status);
					if (notice) console.error(notice);
				}
				if (!isCacheFresh(cache) && !process.env.AGENT_MEMORY_UPGRADE_BACKGROUND) {
					refreshUpgradeCacheBackground();
				}
			} catch {
				// Passive upgrade notice must never break session start.
			}
			try {
				const decision = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).runSessionStart({
					host: agent,
					cwd: process.cwd(),
					signal: new AbortController().signal,
				});
				if (decision) {
					cacheProUsage({
						used: decision.used,
						limit: decision.limit,
						remaining: decision.remaining,
						resetAt: decision.resetAt,
						state: decision.state,
						capability: "session",
					});
					if (decision.state === "exhausted") {
						console.error(
							`AgentMemory free session allowance resets in ${formatResetTime(decision.resetAt)}. Upgrade: ${UPGRADE_URL}`,
						);
					}
				}
			} catch (error) {
				// Paid SessionStart work must never make public-core context unavailable,
				// but a completely silent failure hides broken installs from users and `doctor`.
				const message = error instanceof Error ? error.message : String(error);
				console.error(`AgentMemory Pro session hook failed: ${message}`);
			}
			break;
		}
		case "plugin":
			await cmdPlugin(flags, positional);
			break;
		case "pro":
			await cmdPro(flags, positional);
			break;
		case "upgrade":
			await cmdUpgrade(flags);
			break;
		case "serve":
			await cmdServe(flags);
			break;
		default: {
			const controller = new AbortController();
			const abort = () => controller.abort();
			process.once("SIGINT", abort);
			try {
				const pluginCommand = command === "dashboard" ? "web" : command;

				// Dev-only: AGENT_MEMORY_FORCE_QUOTA_EXHAUSTED=recall (or "learn") injects an
				// exhaustion result so the upgrade-prompt flow can be tested locally without
				// burning through real server quota.
				const forceExhausted = process.env.AGENT_MEMORY_FORCE_QUOTA_EXHAUSTED;
				if (!json && forceExhausted && forceExhausted.split(",").includes(command)) {
					const resetAt = new Date(Date.now() + 18 * 3_600_000).toISOString();
					const forced: CapExhaustedResult = {
						code: "quota_exceeded",
						used: 20,
						limit: 20,
						remaining: 0,
						resetAt,
					};
					cacheProUsage({ used: 20, limit: 20, remaining: 0, resetAt, state: "exhausted", capability: command });
					printCapExhaustedBox(command, forced);
					process.exit(1);
				}

				const result = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).run(pluginCommand, {
					args: positional,
					flags,
					signal: controller.signal,
				});
				if (!result) exitError(`Unknown command: ${command}. Run 'agent-memory help' for usage.`, json);
				if (!result.ok) {
					const capInfo = detectCapExhausted(result);
					if (capInfo && !json) {
						cacheProUsage({
							used: capInfo.used,
							limit: capInfo.limit,
							remaining: capInfo.remaining ?? 0,
							resetAt: capInfo.resetAt,
							state: "exhausted",
							capability: command,
						});
						printCapExhaustedBox(command, capInfo);
						process.exit(1);
					}
					exitError(result.error?.message ?? `Plugin command ${pluginCommand} failed`, json);
				}
				output(result.data ?? { ok: true }, json);
			} finally {
				process.removeListener("SIGINT", abort);
			}
		}
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
