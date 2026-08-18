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

import { COMMAND_DESCRIPTIONS, COMMANDS } from "./cli-spec.js";
import { type CompletionShell, detectCompletionShell, generateCompletion, installCompletion } from "./completions.js";

import {
	_setBaseDir,
	buildMemoryContext,
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
	installSkills,
	memoryWrite,
	nowTimestamp,
	parseScratchpad,
	probeEmbeddings,
	readFileSafe,
	redactSecrets,
	runQmdEmbedDetached,
	runQmdSearch,
	runQmdSync,
	runQmdUpdateNow,
	scheduleQmdUpdate,
	searchRelevantMemories,
	serializeScratchpad,
	setupQmdCollection,
	slugifyTopic,
	todayStr,
	topicPath,
	uninstallSkills,
} from "./core.js";
import { detectHookAgents, type HookAgentKey, installHooks, uninstallHooks } from "./hooks.js";
import {
	createDefaultPluginBootstrap,
	PluginBootstrapFailure,
	type PluginBootstrapResultV1,
} from "./plugin-bootstrap.js";
import type { PluginContextSectionV1 } from "./plugin-host.js";
import { InstalledPluginRuntimeV1 } from "./plugin-runtime.js";

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

function printProOverview(installed: boolean): void {
	console.log("");
	console.log("Core remembers what you save. Pro learns from what you do.");
	console.log("");
	console.log("AgentMemory Pro:");
	console.log("  Recall coding history       Find decisions and context across Pi, Codex, and Claude Code sessions.");
	console.log("  Learn from corrections      Turn repeated fixes into reviewable, reversible memory.");
	console.log("  See and control learning    Inspect what AgentMemory remembers and why in the Memory Dashboard.");
	console.log("");
	console.log("No account is required for the free preview. Your coding history stays on this device.");
	console.log("");
	if (installed) {
		console.log("Try it:");
		console.log('  agent-memory recall "what did we decide about authentication?"');
		console.log("  agent-memory learn");
		console.log("  agent-memory dashboard");
	} else {
		console.log("Start your free Pro preview:");
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

	ensureDirs();
	if (!noSearch && query) await ensureQmdAvailableForSync();
	const searchResults = noSearch ? "" : await searchRelevantMemories(query);
	const coreContext = buildMemoryContext(searchResults);
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
		exitError(`qmd collection '${collName}' not found. Run: agent-memory init`, json);
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
	const { homeDir, targets } = detectHookAgents();
	if (!homeDir) exitError("Home directory not found.", json);
	const eligible = targets.filter(
		(target) => target.supported && target.detected && (!requestedKeys || requestedKeys.has(target.key)),
	);
	const selected = new Set<HookAgentKey>();
	const applyAll = hasFlag(flags, "yes") || hasFlag(flags, "all") || !process.stdin.isTTY;
	for (const target of eligible) {
		if (applyAll || (await promptYesNo(`Install SessionStart hook for ${target.label}?`, true)))
			selected.add(target.key);
	}
	const report = installHooks(selected);
	if (!report.ok) exitError(report.error ?? "install failed", json);
	if (json) return output(report, true);
	if (!report.results.length) return output("No eligible agents. Nothing to install.", false);
	for (const result of report.results) {
		console.log(
			result.installed
				? `Installed ${result.label} hook: ${result.path}`
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
		exitError(`qmd collection '${collName}' not found. Run: agent-memory init`, json);
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

		// Run initial index update + start background embed
		await ensureQmdAvailableForUpdate();
		await runQmdUpdateNow();
		indexUpdated = true;
		const child = runQmdEmbedDetached();
		embedStarted = child !== null;
	}

	if (json) {
		output(
			{
				ok: true,
				directory: dir,
				qmd: qmdFound,
				collectionCreated,
				indexUpdated,
				embedStarted,
			},
			true,
		);
	} else {
		console.log(`Memory directory: ${dir}`);
		console.log(`  MEMORY.md, SCRATCHPAD.md, daily/, topics/ created.`);
		if (qmdFound) {
			if (collectionCreated) {
				console.log(`  qmd collection '${getCollectionName()}' created.`);
			} else {
				console.log(`  qmd collection '${getCollectionName()}' already exists.`);
			}
			if (indexUpdated) {
				console.log(`  Index updated.`);
			}
			if (embedStarted) {
				console.log(`  Embedding started in background.`);
			}
		} else {
			console.log(`  qmd not found — search features unavailable.`);
			console.log(`  Install: bun install -g https://github.com/tobi/qmd`);
		}
		if (process.stdout.isTTY) {
			try {
				const plugin = await createDefaultPluginBootstrap(VERSION).list();
				if (plugin.result === "not_installed") {
					console.log("");
					console.log("Optional: Pro recalls coding history and learns from repeated corrections.");
					console.log("Try it without an account: agent-memory pro install");
				}
			} catch {
				// Commercial discovery must never make core initialization fail.
			}
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
				`Collection '${getCollectionName()}': ${hasCollection ? "configured" : "not configured — run: agent-memory init"}`,
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
installation identifier and requires no account or email. The free preview includes
10 recalls and one learning scan per local day; indexing and the Memory Dashboard
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

async function cmdPro(flags: Record<string, string | boolean>, positional: string[]): Promise<void> {
	const subcommand = positional[0];
	if (!subcommand) {
		await cmdPlugin(flags, ["list"]);
		return;
	}
	const mapped = subcommand === "upgrade" ? "update" : subcommand;
	if (!["install", "status", "update", "manage"].includes(mapped)) {
		const json = hasFlag(flags, "json");
		const message = `Unknown Pro command: ${subcommand}. Available commands: install, status, upgrade, manage.`;
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
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
	const commandWidth = Math.max(...COMMANDS.map((command) => command.length));
	const commandList = COMMANDS.map(
		(command) => `  ${command.padEnd(commandWidth)}  ${COMMAND_DESCRIPTIONS[command]}`,
	).join("\n");

	console.log(`agent-memory — persistent memory for coding agents

Usage:
  agent-memory <command> [options]

Commands:
${commandList}

Global flags:
  --dir <path>   Override memory directory
  --json         Machine-readable JSON output

Examples:
  agent-memory init
  agent-memory write --content "Fixed auth bug in login flow"
  agent-memory write --target long_term --content "User prefers dark mode" --source-uri "session://agent/turn/12"
  agent-memory write --target topic --topic "auth" --content "Rolled JWT refresh to edge"
  agent-memory read --target long_term
  agent-memory read --target daily --date 2026-02-15
  agent-memory read --target list
  agent-memory read --target topic --topic "auth"
  agent-memory read --target topics
  agent-memory scratchpad add --text "Review PR #42"
  agent-memory scratchpad list
  agent-memory scratchpad done --text "PR #42"
  agent-memory search --query "database choice" --mode keyword
  agent-memory distil --dry-run
  agent-memory context --query "database choice"
  agent-memory sync
  agent-memory status --json
  agent-memory completion zsh
  agent-memory install-hooks --yes
  agent-memory pro status
  agent-memory pro install
  agent-memory recall "what did we decide about authentication?"
  agent-memory dashboard`);
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

	if (command === "version" || hasFlag(flags, "version")) {
		output(json ? { version: VERSION } : VERSION, json);
		return;
	}

	if (!command || command === "help" || (hasFlag(flags, "help") && command !== "plugin")) {
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
		case "status":
			await cmdStatus(flags);
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
		case "hook": {
			if (positional[0] !== "session-start") exitError("hook requires 'session-start'", json);
			const agent = getFlag(flags, "agent");
			if (!agent) exitError("hook session-start requires --agent", json);
			await cmdContext({ "no-search": true });
			try {
				const decision = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).runSessionStart({
					host: agent,
					cwd: process.cwd(),
					signal: new AbortController().signal,
				});
				if (decision?.state === "exhausted")
					console.error(`AgentMemory free session allowance resets at ${decision.resetAt}`);
			} catch {
				// Paid SessionStart work must never make public-core context unavailable.
			}
			break;
		}
		case "plugin":
			await cmdPlugin(flags, positional);
			break;
		case "pro":
			await cmdPro(flags, positional);
			break;
		default: {
			const controller = new AbortController();
			const abort = () => controller.abort();
			process.once("SIGINT", abort);
			try {
				const pluginCommand = command === "dashboard" ? "web" : command;
				const result = await new InstalledPluginRuntimeV1({ coreVersion: VERSION }).run(pluginCommand, {
					args: positional,
					flags,
					signal: controller.signal,
				});
				if (!result) exitError(`Unknown command: ${command}. Run 'agent-memory help' for usage.`, json);
				if (!result.ok) exitError(result.error?.message ?? `Plugin command ${pluginCommand} failed`, json);
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
