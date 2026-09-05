/**
 * Upgrade orchestration for the `agent-memory` CLI and its official Pro plugin bundle.
 *
 * Three consumers:
 *   1. `agent-memory upgrade` — explicit user command; checks and (optionally) installs.
 *   2. `agent-memory upgrade --background` — detached, non-interactive; checks, then
 *      installs any target whose `readUpgradePolicy()` value is `"auto"` (an explicit opt-in).
 *      Spawned by `refreshUpgradeCacheBackground()` from `hook session-start`.
 *   3. `agent-memory hook session-start` — passive notice from a 24h-cached record,
 *      including the outcome of the last `--background` auto-install attempt.
 *
 * Network calls always have a hard timeout and always fail closed (upgrade is a
 * quality-of-life feature; a flaky registry must never break the CLI). Same fail-closed
 * contract applies to auto-install: a failed background install is recorded, never
 * retried before the next cache refresh, and never thrown.
 */

import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import { getMemoryDir } from "./core.js";
import { compareVersions } from "./plugin-bootstrap.js";

const NPM_PACKAGE_NAME = "myagentmemory";
const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;
const CLI_RELEASE_NOTES_URL = "https://github.com/jayzeng/agentmemory/releases/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 1_500;

export type InstallManager = "bun" | "homebrew" | "npm" | "pnpm" | "yarn" | "unknown";

export interface InstallMethod {
	manager: InstallManager;
	global: boolean;
	/** Absolute path we think holds the current install (for diagnostics). */
	origin: string;
	/** Argv used to invoke the package manager (e.g. ["npm","i","-g","myagentmemory@latest"]). */
	command: string[];
}

export interface UpgradeCache {
	checkedAt: string;
	cliCurrent: string;
	cliLatest: string | null;
	pluginCurrent: string | null;
	pluginLatest: string | null;
	/** Outcome of the most recent `--background` auto-upgrade attempt, if any. */
	cliAuto?: AutoUpgradeOutcome;
	pluginAuto?: AutoUpgradeOutcome;
}

export interface AutoUpgradeOutcome {
	at: string;
	ok: boolean;
	/** Version installed (ok) or the previous/current version (failure). */
	version: string | null;
	/** Failure reason; absent when ok. */
	error?: string;
}

export interface UpgradeStatus {
	cli: {
		current: string;
		latest: string | null;
		upgradeAvailable: boolean;
	};
	plugin: {
		current: string | null;
		latest: string | null;
		upgradeAvailable: boolean;
	};
	checkedAt: string;
	fromCache: boolean;
}

// ---------------------------------------------------------------------------
// npm registry lookup
// ---------------------------------------------------------------------------

async function fetchLatestFromNpm(fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetchImpl(NPM_LATEST_URL, {
				signal: controller.signal,
				headers: { accept: "application/json" },
			});
			if (!response.ok) return null;
			const body = (await response.json()) as { version?: unknown };
			return typeof body.version === "string" ? body.version : null;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function upgradeCachePath(): string {
	return path.join(getMemoryDir(), "state", "upgrade-check.json");
}

function isValidAutoOutcome(value: unknown): value is AutoUpgradeOutcome {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<AutoUpgradeOutcome>;
	return (
		typeof candidate.at === "string" &&
		typeof candidate.ok === "boolean" &&
		(candidate.version === null || typeof candidate.version === "string") &&
		(candidate.error === undefined || typeof candidate.error === "string")
	);
}

export function readUpgradeCache(): UpgradeCache | null {
	try {
		const raw = fs.readFileSync(upgradeCachePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<UpgradeCache>;
		if (
			typeof parsed.checkedAt !== "string" ||
			typeof parsed.cliCurrent !== "string" ||
			(parsed.cliLatest !== null && typeof parsed.cliLatest !== "string") ||
			(parsed.pluginCurrent !== null &&
				typeof parsed.pluginCurrent !== "string" &&
				parsed.pluginCurrent !== undefined) ||
			(parsed.pluginLatest !== null && typeof parsed.pluginLatest !== "string" && parsed.pluginLatest !== undefined)
		) {
			return null;
		}
		return {
			checkedAt: parsed.checkedAt,
			cliCurrent: parsed.cliCurrent,
			cliLatest: parsed.cliLatest ?? null,
			pluginCurrent: parsed.pluginCurrent ?? null,
			pluginLatest: parsed.pluginLatest ?? null,
			cliAuto: isValidAutoOutcome(parsed.cliAuto) ? parsed.cliAuto : undefined,
			pluginAuto: isValidAutoOutcome(parsed.pluginAuto) ? parsed.pluginAuto : undefined,
		};
	} catch {
		return null;
	}
}

export function writeUpgradeCache(record: UpgradeCache): void {
	const file = upgradeCachePath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
	} catch {
		// Cache write failures are non-fatal.
	}
}

export function isCacheFresh(record: UpgradeCache | null, now = Date.now()): boolean {
	if (!record) return false;
	const checked = Date.parse(record.checkedAt);
	if (!Number.isFinite(checked)) return false;
	return now - checked < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Auto-upgrade policy (off / notify / auto), per target
// ---------------------------------------------------------------------------

export type UpgradePolicyValue = "off" | "notify" | "auto";
export interface UpgradePolicy {
	cli: UpgradePolicyValue;
	plugin: UpgradePolicyValue;
}

const UPGRADE_POLICY_FILENAME = "upgrade-policy.json";
const UPGRADE_POLICY_DEFAULT: UpgradePolicy = { cli: "notify", plugin: "notify" };

function upgradePolicyPath(): string {
	return path.join(getMemoryDir(), "state", UPGRADE_POLICY_FILENAME);
}

function isPolicyValue(value: unknown): value is UpgradePolicyValue {
	return value === "off" || value === "notify" || value === "auto";
}

/**
 * Resolve the persisted auto-upgrade policy.
 * Precedence per target: `AGENT_MEMORY_AUTO_UPGRADE_{CLI,PLUGIN}` env var →
 * `<memoryDir>/state/upgrade-policy.json` → default `"notify"`.
 *
 * `existed` tells callers whether the policy file was already on disk —
 * used to fire a one-time update-policy notice on first read.
 */
export function readUpgradePolicy(): UpgradePolicy & { existed: boolean } {
	let stored: Partial<UpgradePolicy> = {};
	let existed = false;
	try {
		const raw = fs.readFileSync(upgradePolicyPath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<UpgradePolicy>;
		if (isPolicyValue(parsed.cli) || isPolicyValue(parsed.plugin)) {
			stored = parsed;
			existed = true;
		}
	} catch {}

	const envCli = process.env.AGENT_MEMORY_AUTO_UPGRADE_CLI;
	const envPlugin = process.env.AGENT_MEMORY_AUTO_UPGRADE_PLUGIN;

	return {
		cli: isPolicyValue(envCli) ? envCli : isPolicyValue(stored.cli) ? stored.cli : UPGRADE_POLICY_DEFAULT.cli,
		plugin: isPolicyValue(envPlugin)
			? envPlugin
			: isPolicyValue(stored.plugin)
				? stored.plugin
				: UPGRADE_POLICY_DEFAULT.plugin,
		existed,
	};
}

/** Atomically persist the auto-upgrade policy. Merges with whatever is already on disk. */
export function writeUpgradePolicy(patch: Partial<UpgradePolicy>): UpgradePolicy {
	const current = readUpgradePolicy();
	const next: UpgradePolicy = {
		cli: patch.cli ?? current.cli,
		plugin: patch.plugin ?? current.plugin,
	};
	const target = upgradePolicyPath();
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, target);
	return next;
}

// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------

export function resolveSelfLaunch(input: {
	execPath: string;
	scriptCandidate: string | undefined;
	fileExists: (candidate: string) => boolean;
}): { command: string; args: string[] } {
	const scriptCandidate = input.scriptCandidate;
	const isRealScript =
		typeof scriptCandidate === "string" &&
		scriptCandidate.length > 0 &&
		!scriptCandidate.startsWith("/$bunfs/") &&
		input.fileExists(scriptCandidate);
	return isRealScript ? { command: input.execPath, args: [scriptCandidate] } : { command: input.execPath, args: [] };
}

function currentSelfLaunch(): { command: string; args: string[] } {
	return resolveSelfLaunch({
		execPath: process.execPath,
		scriptCandidate: process.argv[1],
		fileExists: fs.existsSync,
	});
}

function selfInstallPath(): string {
	const launch = currentSelfLaunch();
	const candidate = launch.args[0] ?? launch.command;
	try {
		return fs.realpathSync(candidate);
	} catch {
		try {
			return url.fileURLToPath(import.meta.url);
		} catch {
			return candidate;
		}
	}
}

/**
 * Best-effort detection of how `myagentmemory` was installed. Path signatures
 * are heuristic but cover the common managers. On no match we fall back to
 * `npm -g` per the user's choice ("best-effort try anyway").
 */
export function detectInstallMethod(location: string = selfInstallPath()): InstallMethod {
	const normalized = location.replace(/\\/g, "/");
	const home = os.homedir().replace(/\\/g, "/");
	const pkg = `${NPM_PACKAGE_NAME}@latest`;

	// Compiled CLI installed by the official Homebrew formula. Resolve symlinks
	// before detection so /opt/homebrew/bin/agent-memory reaches its Cellar path.
	if (normalized.includes("/Cellar/agent-memory/")) {
		return {
			manager: "homebrew",
			global: true,
			origin: location,
			command: ["brew", "upgrade", "jayzeng/agentmemory/agent-memory"],
		};
	}

	// bun global install
	if (normalized.includes("/.bun/install/global/") || normalized.includes("/bun/install/global/")) {
		return { manager: "bun", global: true, origin: location, command: ["bun", "add", "-g", pkg] };
	}
	// pnpm global (Linux, macOS layouts)
	if (
		normalized.includes("/.local/share/pnpm/global/") ||
		normalized.includes("/Library/pnpm/global/") ||
		normalized.includes("/AppData/Local/pnpm/global/") ||
		normalized.includes("/pnpm-global/")
	) {
		return { manager: "pnpm", global: true, origin: location, command: ["pnpm", "add", "-g", pkg] };
	}
	// yarn global
	if (normalized.includes("/yarn/global/") || normalized.includes("/.config/yarn/global/")) {
		return { manager: "yarn", global: true, origin: location, command: ["yarn", "global", "add", pkg] };
	}
	// npm global — common prefixes across nvm, homebrew, system node, npm-global override
	const npmGlobalSignatures = ["/lib/node_modules/", "/npm-global/", "/.nvm/versions/node/", "/AppData/Roaming/npm/"];
	if (npmGlobalSignatures.some((sig) => normalized.includes(sig))) {
		return { manager: "npm", global: true, origin: location, command: ["npm", "install", "-g", pkg] };
	}
	// Local checkout, npx cache, or unknown — best-effort with npm -g.
	void home;
	return {
		manager: "unknown",
		global: false,
		origin: location,
		command: ["npm", "install", "-g", pkg],
	};
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface InstallResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	command: string[];
}

export function runInstaller(method: InstallMethod, opts: SpawnOptions = {}): InstallResult {
	const [cmd, ...args] = method.command;
	const result = spawnSync(cmd, args, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
		env: process.env,
		...opts,
	});
	return {
		ok: result.status === 0,
		code: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		command: method.command,
	};
}

// ---------------------------------------------------------------------------
// Passive: refresh cache in background
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: spawn a detached child that runs `agent-memory upgrade
 * --background --refresh --quiet` so the next session-start has a fresh
 * cache. Unlike a plain check, `--background` also installs any target whose
 * policy is `"auto"` (see `readUpgradePolicy`) — this is the one place
 * auto-upgrade actually happens. Never awaits, never throws.
 */
export function refreshUpgradeCacheBackground(): void {
	try {
		const launch = currentSelfLaunch();
		if (!launch.command) return;
		const child = spawn(
			launch.command,
			[...launch.args, "upgrade", "--background", "--refresh", "--quiet", "--json"],
			{
				detached: true,
				stdio: "ignore",
				env: { ...process.env, AGENT_MEMORY_UPGRADE_BACKGROUND: "1" },
			},
		);
		child.unref();
	} catch {
		// Background refresh is best-effort.
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CheckOptions {
	cliCurrent: string;
	pluginCurrent: string | null;
	/** When true, do NOT hit the network — read cache only. Returns fromCache=true even on miss. */
	cacheOnly?: boolean;
	/** When true, force a network refresh and rewrite the cache regardless of freshness. */
	refresh?: boolean;
	/** Optional injected npm fetcher (used by tests). */
	fetchCliLatest?: () => Promise<string | null>;
	/** Optional injected plugin-latest resolver. When omitted, plugin latest is taken from pluginLatestHint. */
	pluginLatestHint?: string | null;
	/** Explicit signal from the bootstrap that a newer release exists even when the version number is unknown. */
	pluginUpgradeAvailable?: boolean;
}

export async function checkForUpgrades(opts: CheckOptions): Promise<UpgradeStatus> {
	const cached = readUpgradeCache();
	const fresh = isCacheFresh(cached);
	const useCache = !opts.refresh && (opts.cacheOnly || fresh);

	let cliLatest: string | null = null;
	let pluginLatest: string | null = null;
	let checkedAt: string;
	let fromCache = false;

	if (useCache && cached) {
		cliLatest = cached.cliLatest;
		pluginLatest = opts.pluginLatestHint ?? cached.pluginLatest;
		checkedAt = cached.checkedAt;
		fromCache = true;
	} else if (opts.cacheOnly) {
		// Cache miss and network is disallowed — return an empty snapshot.
		checkedAt = new Date().toISOString();
		fromCache = true;
	} else {
		const fetcher = opts.fetchCliLatest ?? (() => fetchLatestFromNpm());
		cliLatest = await fetcher();
		pluginLatest = opts.pluginLatestHint ?? null;
		checkedAt = new Date().toISOString();
		writeUpgradeCache({
			checkedAt,
			cliCurrent: opts.cliCurrent,
			cliLatest,
			pluginCurrent: opts.pluginCurrent,
			pluginLatest,
		});
	}

	return {
		cli: {
			current: opts.cliCurrent,
			latest: cliLatest,
			upgradeAvailable: Boolean(cliLatest && compareVersions(cliLatest, opts.cliCurrent) > 0),
		},
		plugin: {
			current: opts.pluginCurrent,
			latest: pluginLatest,
			upgradeAvailable:
				Boolean(opts.pluginUpgradeAvailable) ||
				Boolean(pluginLatest && opts.pluginCurrent && compareVersions(pluginLatest, opts.pluginCurrent) > 0),
		},
		checkedAt,
		fromCache,
	};
}

function displayWidth(value: string): number {
	let width = 0;
	for (const character of value) {
		if (/\p{Mark}/u.test(character) || character === "\uFE0F") continue;
		width += /\p{Extended_Pictographic}/u.test(character) ? 2 : 1;
	}
	return width;
}

function renderNoticeBox(lines: string[]): string {
	const contentWidth = Math.max(...lines.map(displayWidth));
	const border = "─".repeat(contentWidth + 2);
	return [
		`╭${border}╮`,
		...lines.map((line) => `│ ${line}${" ".repeat(contentWidth - displayWidth(line))} │`),
		`╰${border}╯`,
	].join("\n");
}

function formatAvailableUpgradeNotice(status: UpgradeStatus): string {
	const lines: string[] = [];
	if (status.cli.upgradeAvailable) {
		lines.push(`✨ Update available! ${status.cli.current} -> ${status.cli.latest ?? "new"}`);
		if (status.plugin.upgradeAvailable) {
			lines.push(`AgentMemory Pro ${status.plugin.current ?? "?"} -> ${status.plugin.latest ?? "new"}`);
		}
	} else {
		lines.push(
			`✨ Update available! AgentMemory Pro ${status.plugin.current ?? "?"} -> ${status.plugin.latest ?? "new"}`,
		);
	}
	lines.push("Run agent-memory upgrade to update.");
	if (status.cli.upgradeAvailable) {
		lines.push("", "See full release notes:", CLI_RELEASE_NOTES_URL);
	}
	return renderNoticeBox(lines);
}

/**
 * `cache` (when passed) lets this distinguish a plain "notify" signal from the
 * outcome of the last `--background` auto-install attempt for that target:
 *   - succeeded, but this process is running older code than what's on disk
 *     (e.g. a long-running `serve --mcp`) → "auto-upgraded, restart to use it"
 *   - failed → surface the error and point at the manual command
 *   - succeeded and already caught up (this process's own version matches) → silent
 */
export function formatUpgradeNotice(
	status: UpgradeStatus,
	cache?: UpgradeCache | null,
	policy?: Pick<UpgradePolicy, "cli" | "plugin">,
): string | null {
	const parts: string[] = [];
	let needsManualRun = false;
	let reportedAutoOutcome = false;
	const cliEnabled = policy?.cli !== "off";
	const pluginEnabled = policy?.plugin !== "off";
	const cliUpgradeAvailable = cliEnabled && status.cli.upgradeAvailable;
	const pluginUpgradeAvailable = pluginEnabled && status.plugin.upgradeAvailable;

	if (cliEnabled && cache?.cliAuto && !cache.cliAuto.ok) {
		parts.push(`CLI auto-upgrade failed (${cache.cliAuto.error ?? "unknown error"})`);
		needsManualRun = true;
		reportedAutoOutcome = true;
	} else if (
		cliEnabled &&
		cache?.cliAuto?.ok &&
		cache.cliAuto.version &&
		cache.cliAuto.version !== status.cli.current
	) {
		parts.push(
			`CLI auto-upgraded → ${cache.cliAuto.version} (restart any long-running agent-memory process to use it)`,
		);
		reportedAutoOutcome = true;
	} else if (cliUpgradeAvailable) {
		parts.push(`CLI ${status.cli.current} → ${status.cli.latest ?? "new"}`);
		needsManualRun = true;
	}

	if (pluginEnabled && cache?.pluginAuto && !cache.pluginAuto.ok) {
		parts.push(`Pro auto-upgrade failed (${cache.pluginAuto.error ?? "unknown error"})`);
		needsManualRun = true;
		reportedAutoOutcome = true;
	} else if (
		pluginEnabled &&
		cache?.pluginAuto?.ok &&
		cache.pluginAuto.version &&
		cache.pluginAuto.version !== status.plugin.current
	) {
		parts.push(`Pro auto-upgraded → ${cache.pluginAuto.version}`);
		reportedAutoOutcome = true;
	} else if (pluginUpgradeAvailable) {
		parts.push(`Pro ${status.plugin.current ?? "?"} → ${status.plugin.latest ?? "new"}`);
		needsManualRun = true;
	}

	if (!parts.length) return null;
	if (needsManualRun && !reportedAutoOutcome) {
		return formatAvailableUpgradeNotice({
			...status,
			cli: { ...status.cli, upgradeAvailable: cliUpgradeAvailable },
			plugin: { ...status.plugin, upgradeAvailable: pluginUpgradeAvailable },
		});
	}
	return `agent-memory: ${parts.join("; ")}${needsManualRun ? ". Run: agent-memory upgrade" : ""}`;
}
