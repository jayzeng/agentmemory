/**
 * Upgrade orchestration for the `agent-memory` CLI and its official Pro plugin bundle.
 *
 * Two consumers:
 *   1. `agent-memory upgrade` — explicit user command; checks and (optionally) installs.
 *   2. `agent-memory hook session-start` — passive notice from a 24h-cached record.
 *
 * Network calls always have a hard timeout and always fail closed (upgrade is a
 * quality-of-life feature; a flaky registry must never break the CLI).
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
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 1_500;

export type InstallManager = "bun" | "npm" | "pnpm" | "yarn" | "unknown";

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
// Install-method detection
// ---------------------------------------------------------------------------

function selfInstallPath(): string {
	try {
		return url.fileURLToPath(import.meta.url);
	} catch {
		return process.argv[1] ?? "";
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
 * --check --refresh --quiet` so the next session-start has a fresh cache.
 * Never awaits, never throws.
 */
export function refreshUpgradeCacheBackground(): void {
	try {
		const binary = process.argv[0];
		const script = process.argv[1];
		if (!binary || !script) return;
		const child = spawn(binary, [script, "upgrade", "--check", "--refresh", "--quiet", "--json"], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, AGENT_MEMORY_UPGRADE_BACKGROUND: "1" },
		});
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

export function formatUpgradeNotice(status: UpgradeStatus): string | null {
	const parts: string[] = [];
	if (status.cli.upgradeAvailable) parts.push(`CLI ${status.cli.current} → ${status.cli.latest ?? "new"}`);
	if (status.plugin.upgradeAvailable)
		parts.push(`Pro ${status.plugin.current ?? "?"} → ${status.plugin.latest ?? "new"}`);
	if (!parts.length) return null;
	return `agent-memory: upgrade available (${parts.join(", ")}). Run: agent-memory upgrade`;
}
