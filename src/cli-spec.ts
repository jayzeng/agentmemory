export type CliValueKind = "directory" | "file" | "number" | "value";

export interface CliOptionSpec {
	description: string;
	value?: {
		label: string;
		kind: CliValueKind;
	};
}

export const COMMANDS = [
	"context",
	"save",
	"note",
	"write",
	"read",
	"scratchpad",
	"search",
	"distil",
	"sync",
	"setup",
	"status",
	"doctor",
	"tutorial",
	"install-skills",
	"uninstall-skills",
	"install-hooks",
	"uninstall-hooks",
	"uninstall",
	"completion",
	"pro",
	"recall",
	"learn",
	"dashboard",
	"plugin",
	"serve",
	"upgrade",
	"version",
	"help",
] as const;

export const PLUGIN_COMMANDS = ["list", "status", "install", "update", "uninstall", "manage"] as const;

export const WORKER_ACTIONS = [] as const;
export const SCRATCHPAD_ACTIONS = ["add", "done", "undo", "clear_done", "list"] as const;

export const COMMAND_DESCRIPTIONS: Record<(typeof COMMANDS)[number], string> = {
	context: "build context from scratchpad, logs, topics, and long-term memory",
	save: 'shortcut: agent-memory save "<text>" → daily memory entry',
	note: 'shortcut: agent-memory note "<text>" → scratchpad checklist item',
	write: "append or overwrite a daily, topic, or long-term memory entry",
	read: "read daily, topic, scratchpad, or long-term memory",
	scratchpad: "add, complete, reopen, list, or clear persistent checklist items",
	search: "search indexed memory with keyword, semantic, or deep qmd modes",
	distil: "rebuild a compact MEMORY.md index from logs and topics",
	sync: "update the qmd index and semantic embeddings",
	setup: "one-shot idempotent installer: init + skills + hooks + plugin + mcp",
	status: "show memory paths, file counts, qmd, and embedding health",
	doctor: "run a one-shot health check across memory, qmd, skills, hooks, and Pro",
	tutorial: "guided 3-minute walkthrough in a throwaway sandbox",
	"install-skills": "install core instructions for detected agents",
	"uninstall-skills": "remove core instructions from detected agents",
	"install-hooks": "install managed context and memory-write reminder hooks",
	"uninstall-hooks": "remove only hooks managed by agent-memory",
	uninstall:
		"remove hooks, skills, MCP registrations, completions, and the Pro plugin; add --data to also delete memory data",
	completion: "install or print Bash, Zsh, Fish, or PowerShell completion",
	pro: "install, inspect, or upgrade AgentMemory Pro",
	recall: "recall decisions and context from prior coding sessions with Pro",
	learn: "find repeated corrections worth remembering with Pro",
	dashboard: "open the private local Memory Dashboard",
	plugin: "discover, install, update, or remove optional official plugins",
	serve: "run as a Model Context Protocol (MCP) server over stdio",
	upgrade: "check for, and auto-install by default, newer agent-memory CLI and Pro plugin releases",
	version: "print the installed agent-memory version",
	help: "show this command overview",
};

export const PLUGIN_COMMAND_DESCRIPTIONS: Record<(typeof PLUGIN_COMMANDS)[number], string> = {
	list: "list optional official plugins and local availability",
	status: "show the installed bundle and entitlement state",
	install: "authenticate if needed, then install or upgrade the official bundle",
	update: "upgrade an existing official bundle when a compatible release exists",
	uninstall: "remove official plugin executables while preserving user data",
	manage: "open the AgentMemory account and billing website",
};

export const WORKER_ACTION_DESCRIPTIONS: Record<(typeof WORKER_ACTIONS)[number], string> = {};

export const SCRATCHPAD_ACTION_DESCRIPTIONS: Record<(typeof SCRATCHPAD_ACTIONS)[number], string> = {
	add: "add a new open checklist item; requires --text",
	done: "complete the first open substring match; requires --text",
	undo: "reopen the first completed substring match; requires --text",
	clear_done: "remove every completed checklist item",
	list: "show checklist items and completion counts",
};

export const GLOBAL_OPTIONS = ["--dir", "--json", "--help", "--version", "-h", "-V"] as const;

export const COMMAND_OPTIONS: Record<string, readonly string[]> = {
	context: ["--query", "--no-search", "--layer"],
	save: ["--target"],
	note: [],
	write: ["--content", "--target", "--mode", "--topic", "--date", "--source-uri"],
	read: ["--target", "--date", "--topic"],
	scratchpad: ["--text"],
	search: ["--query", "--mode", "--limit"],
	distil: ["--dry-run"],
	sync: [],
	init: ["--yes", "--skip-skills", "--skip-hooks"],
	setup: ["--yes", "--skip-skills", "--skip-hooks", "--skip-plugin", "--skip-mcp"],
	status: ["--probe"],
	doctor: [],
	tutorial: [],
	"install-skills": ["--uninstall"],
	"uninstall-skills": [],
	"install-hooks": ["--yes", "--all", "--only", "--mode"],
	"uninstall-hooks": ["--only"],
	uninstall: ["--data", "--yes"],
	completion: ["--stdout"],
	pro: [],
	recall: [
		"--scope",
		"--cwd",
		"--limit",
		"--context",
		"--queries",
		"--multi",
		"--sessions",
		"--events",
		"--per-query",
	],
	learn: ["--preview"],
	dashboard: ["--no-browser"],
	serve: ["--mcp", "--register", "--only"],
	upgrade: ["--check", "--refresh", "--yes", "--quiet", "--cli", "--plugin", "--background"],
	version: [],
	help: [],
};

export const PLUGIN_COMMAND_OPTIONS: Record<string, readonly string[]> = {
	list: [],
	status: ["--channel"],
	install: ["--channel", "--no-browser", "--yes"],
	update: ["--channel"],
	uninstall: ["--yes"],
	manage: ["--no-browser"],
	// Plugin runtime commands forwarded to the installed bundle
	index: ["--date", "--since"],
	recall: ["--query", "--limit", "--cwd", "--host", "--mode"],
	worker: ["--token"],
	learn: ["--limit", "--dry-run"],
	eval: ["--limit"],
};

export const WORKER_ACTION_OPTIONS: Record<string, readonly string[]> = {};

export const SCRATCHPAD_ACTION_OPTIONS: Record<string, readonly string[]> = {
	add: ["--text"],
	done: ["--text"],
	undo: ["--text"],
	clear_done: [],
	list: [],
};

export const OPTION_SPECS: Record<string, CliOptionSpec> = {
	"--dir": { description: "override the active memory directory", value: { label: "directory", kind: "directory" } },
	"--json": { description: "emit command-specific structured JSON" },
	"--help": { description: "show help for the selected command" },
	"--version": { description: "print the installed version and exit" },
	"-h": { description: "show help for the selected command" },
	"-V": { description: "print the installed version and exit" },
	"--query": { description: "memory search or context-retrieval query", value: { label: "text", kind: "value" } },
	"--no-search": { description: "build context without invoking qmd" },
	"--content": { description: "memory entry content to persist", value: { label: "text", kind: "value" } },
	"--target": { description: "memory destination or collection to read", value: { label: "target", kind: "value" } },
	"--mode": {
		description: "write behavior, qmd search strategy, or hook mode (stable|per-turn)",
		value: { label: "mode", kind: "value" },
	},
	"--layer": {
		description: "context layer to emit: stable, dynamic, or full (default)",
		value: { label: "layer", kind: "value" },
	},
	"--topic": { description: "topic name used to resolve a topic file", value: { label: "name", kind: "value" } },
	"--date": { description: "daily-log date in YYYY-MM-DD form", value: { label: "date", kind: "value" } },
	"--source-uri": {
		description: "optional provenance URI stored with an entry",
		value: { label: "uri", kind: "value" },
	},
	"--text": { description: "checklist item text or substring to match", value: { label: "text", kind: "value" } },
	"--limit": { description: "maximum number of search or recall results", value: { label: "number", kind: "number" } },
	"--dry-run": { description: "preview generated memory without writing MEMORY.md" },
	"--probe": { description: "run a live semantic query to verify embeddings" },
	"--since": { description: "metrics reporting window in days", value: { label: "days", kind: "number" } },
	"--port": {
		description: "web-console port; use 0 to select an available port",
		value: { label: "number", kind: "number" },
	},
	"--state": { description: "override the plugin state root", value: { label: "directory", kind: "directory" } },
	"--with-plugin": { description: "include both the core and optional plugin skills" },
	"--plugin-only": { description: "operate only on the optional plugin skill" },
	"--yes": { description: "apply eligible changes without interactive prompts" },
	"--all": { description: "apply eligible hook changes without confirmation" },
	"--skip-skills": { description: "init: don't prompt to install agent skills" },
	"--skip-hooks": { description: "init: don't prompt to install SessionStart hooks" },
	"--skip-plugin": { description: "setup: don't offer to install the paid plugin bundle" },
	"--skip-mcp": { description: "setup: don't register the MCP server in detected local harnesses" },
	"--preview": { description: "learn: show detected patterns without writing or consuming quota" },
	"--only": {
		description: "restrict hook changes to comma-separated agent keys",
		value: { label: "agents", kind: "value" },
	},
	"--stdout": { description: "print the completion script without installing it" },
	"--channel": {
		description: "select the official release channel",
		value: { label: "channel", kind: "value" },
	},
	"--no-browser": { description: "print account URLs instead of opening a browser" },
	"--scope": {
		description: "search globally or only in the current workspace",
		value: { label: "scope", kind: "value" },
	},
	"--cwd": {
		description: "restrict session operations to a working directory",
		value: { label: "directory", kind: "directory" },
	},
	"--context": {
		description: "surrounding events included with each recall hit",
		value: { label: "number", kind: "number" },
	},
	"--queries": {
		description: "JSON array of query strings for one-shot multi-query recall",
		value: { label: "json", kind: "value" },
	},
	"--multi": { description: "treat each positional argument as a separate recall query" },
	"--sessions": {
		description: "maximum sessions returned by multi-query recall",
		value: { label: "number", kind: "number" },
	},
	"--events": {
		description: "top events per session returned by multi-query recall",
		value: { label: "number", kind: "number" },
	},
	"--per-query": {
		description: "candidate hits considered per query before fusion",
		value: { label: "number", kind: "number" },
	},
	"--pi": { description: "override the Pi session root", value: { label: "directory", kind: "directory" } },
	"--codex": { description: "override the Codex session root", value: { label: "directory", kind: "directory" } },
	"--claude": {
		description: "override the Claude Code session root",
		value: { label: "directory", kind: "directory" },
	},
	"--host": {
		description: "session host (pi/codex/claude) or web loopback bind address",
		value: { label: "host", kind: "value" },
	},
	"--max-per-host": {
		description: "maximum session files read from each host",
		value: { label: "number", kind: "number" },
	},
	"--recent": {
		description: "most recently modified session files refreshed per host",
		value: { label: "number", kind: "number" },
	},
	"--interval": {
		description: "watch polling interval in milliseconds",
		value: { label: "milliseconds", kind: "number" },
	},
	"--once": { description: "run one watch iteration and exit" },
	"--lines": {
		description: "number of recent worker log entries to return",
		value: { label: "number", kind: "number" },
	},
	"--threshold": {
		description: "minimum repeated evidence required for a candidate",
		value: { label: "number", kind: "number" },
	},
	"--output": { description: "also write the report to this file", value: { label: "file", kind: "file" } },
	"--replay": { description: "back up and rebuild derived learning layers" },
	"--journal": {
		description: "override the experience journal directory",
		value: { label: "directory", kind: "directory" },
	},
	"--candidates-dir": {
		description: "override the candidate ledger directory",
		value: { label: "directory", kind: "directory" },
	},
	"--decisions-dir": {
		description: "override the decision ledger directory",
		value: { label: "directory", kind: "directory" },
	},
	"--auto-dir": {
		description: "override the materialized auto-memory directory",
		value: { label: "directory", kind: "directory" },
	},
	"--agent": { description: "internal SessionStart host key", value: { label: "agent", kind: "value" } },
	"--token": { description: "internal session-worker lease token", value: { label: "token", kind: "value" } },
	"--uninstall": { description: "use install-skills compatibility uninstall mode" },
	"--data": { description: "uninstall: also permanently delete the memory directory and plugin state" },
	"--mcp": { description: "serve as an MCP server over stdio (used by Claude Code)" },
	"--register": { description: "register the MCP server in detected supported agents and exit" },
	"--check": { description: "upgrade: report available updates without installing" },
	"--refresh": { description: "upgrade: force a live registry lookup and rewrite the 24h cache" },
	"--quiet": { description: "upgrade: suppress non-error output (used by the passive session-start refresh)" },
	"--cli": { description: "upgrade: limit action to the CLI binary" },
	"--plugin": { description: "upgrade: limit action to the Pro plugin bundle" },
	"--background": {
		description:
			"upgrade: non-interactive; installs only targets whose policy is 'auto' (see: agent-memory upgrade policy)",
	},
};

export const SHELL_DESCRIPTIONS: Record<string, string> = {
	bash: "generate or install Bash completion",
	zsh: "generate or install Zsh completion",
	fish: "generate or install Fish completion",
	powershell: "generate or install PowerShell completion",
};

export function optionDescription(option: string): string {
	return OPTION_SPECS[option]?.description ?? option;
}

export function optionTakesValue(option: string): boolean {
	return OPTION_SPECS[option]?.value !== undefined;
}

// One-line usage template per command — shows the shape agents/humans should type.
const COMMAND_USAGE: Record<string, string> = {
	context: 'agent-memory context [--query "text"] [--no-search] [--json]',
	save: 'agent-memory save "<text>" [--target daily|topic|long_term]',
	note: 'agent-memory note "<text>"',
	write: 'agent-memory write "<text>" [--target daily|topic|long_term] [--mode append|overwrite] [--topic <name>] [--date YYYY-MM-DD]',
	read: "agent-memory read [--target daily|topic|long_term|scratchpad] [--date YYYY-MM-DD] [--topic <name>]",
	scratchpad: 'agent-memory scratchpad <add|done|undo|clear_done|list> [--text "text"]',
	search: 'agent-memory search --query "text" [--mode keyword|semantic|deep] [--limit N]',
	distil: "agent-memory distil [--dry-run]",
	sync: "agent-memory sync",
	init: "agent-memory init [--yes] [--skip-skills] [--skip-hooks]",
	setup: "agent-memory setup [--yes] [--json]",
	status: "agent-memory status [--probe] [--json]",
	doctor: "agent-memory doctor [--json]",
	tutorial: "agent-memory tutorial",
	"install-skills": "agent-memory install-skills [--json]",
	"uninstall-skills": "agent-memory uninstall-skills [--json]",
	"install-hooks":
		"agent-memory install-hooks [--yes] [--all] [--only claude,codex,cursor] [--mode stable|per-turn] [--json]",
	"uninstall-hooks": "agent-memory uninstall-hooks [--only claude,codex,cursor] [--json]",
	uninstall: "agent-memory uninstall [--data] [--yes] [--json]",
	completion: "agent-memory completion [bash|zsh|fish|powershell] [--stdout]",
	pro: "agent-memory pro <install|status|upgrade> [--channel stable] [--yes]",
	recall:
		'agent-memory recall "<query>" [--limit N] [--context N] [--scope current|global] [--cwd <path>] [--json]\n  Multi-query: agent-memory recall --queries \'["q1","q2","q3"]\' [--sessions N] [--events N]',
	learn: "agent-memory learn [--preview] [--json]",
	dashboard: "agent-memory dashboard [--no-browser]",
	plugin:
		"agent-memory plugin <list|status|install|update|uninstall|manage> [--channel stable] [--yes] [--no-browser]",
	upgrade:
		"agent-memory upgrade [--check] [--yes] [--cli|--plugin] [--refresh] [--json]\n  agent-memory upgrade policy [off|notify|auto] [--cli|--plugin] [--json]  (default: auto for both)",
	version: "agent-memory version",
	help: "agent-memory help [<command>]",
};

// Concrete examples per command — what an agent or dev is most likely to want.
const COMMAND_EXAMPLES: Record<string, string[]> = {
	save: [
		'agent-memory save "shipped the new recall path — bundle at 1.2.3"',
		'agent-memory save --target long_term "prefer bun test over npm test in example-api"',
	],
	note: ['agent-memory note "verify the digest backfill against a real corpus"'],
	write: [
		'agent-memory write "keep sessions in reverse-chron order" --target long_term --mode overwrite',
		'agent-memory write "half-line summary" --target topic --topic scheduling-machine',
	],
	read: [
		"agent-memory read --target long_term",
		"agent-memory read --target daily --date 2026-08-24",
		"agent-memory read --target topic --topic scheduling-machine",
	],
	scratchpad: [
		'agent-memory scratchpad add --text "chase down the flake in test/web.test.ts"',
		'agent-memory scratchpad done --text "chase down the flake"',
		"agent-memory scratchpad list",
	],
	search: [
		'agent-memory search --query "API test collection credentials"',
		'agent-memory search --query "grafana alert routing" --mode semantic --limit 10',
	],
	recall: [
		'agent-memory recall "API test collection for booking service"',
		'agent-memory recall --queries \'["API test collection for booking service","booking client integration","client credential setup"]\' --sessions 5',
		'agent-memory recall "auth refresh" --scope current --limit 5',
	],
	context: ["agent-memory context", 'agent-memory context --query "grafana alerts" --json'],
	status: ["agent-memory status", "agent-memory status --json"],
	init: ["agent-memory init", "agent-memory init --yes --skip-hooks"],
	setup: ["agent-memory setup", "agent-memory setup --json"],
	uninstall: [
		"agent-memory uninstall --yes  # removes hooks, skills, MCP registrations, completions, Pro plugin",
		"agent-memory uninstall --data --yes  # also deletes MEMORY.md, daily logs, scratchpad, topics",
	],
	"install-hooks": [
		"agent-memory install-hooks",
		"agent-memory install-hooks --yes",
		"agent-memory install-hooks --only claude,codex",
		"agent-memory install-hooks --mode stable  # SessionStart only (skip UserPromptSubmit)",
	],
	distil: ["agent-memory distil", "agent-memory distil --dry-run"],
	learn: ["agent-memory learn", "agent-memory learn --preview  # see patterns without consuming quota or writing"],
};

/**
 * Render per-command help using existing spec metadata. Called when the user
 * runs `agent-memory <cmd> --help` — should list the command's real flags with
 * descriptions and one or two concrete examples, not the top-level command list.
 */
export function renderCommandHelp(command: string): string {
	const canonical = command === "distill" ? "distil" : command;
	const known = new Set<string>([...COMMANDS, "distill", "setup"]);
	if (!known.has(canonical)) {
		return `agent-memory: unknown command '${command}'. Run 'agent-memory help' for the full list.`;
	}
	const description =
		COMMAND_DESCRIPTIONS[canonical as (typeof COMMANDS)[number]] ??
		(canonical === "setup" ? "one-shot idempotent installer: init + skills + hooks + plugin + mcp" : "");
	const usage = COMMAND_USAGE[canonical] ?? `agent-memory ${canonical} [options]`;
	const options = COMMAND_OPTIONS[canonical] ?? [];
	const examples = COMMAND_EXAMPLES[canonical] ?? [];

	const optLines: string[] = [];
	// Command-specific options
	for (const opt of options) {
		const spec = OPTION_SPECS[opt];
		if (!spec) continue;
		const label = spec.value ? `${opt} <${spec.value.label}>` : opt;
		optLines.push(`  ${label.padEnd(24)}  ${spec.description}`);
	}
	// Global options that are always available
	const globalKeys = ["--dir", "--json", "--help", "--version"];
	const globalLines = globalKeys
		.map((opt) => {
			const spec = OPTION_SPECS[opt];
			if (!spec) return "";
			const label = spec.value ? `${opt} <${spec.value.label}>` : opt;
			return `  ${label.padEnd(24)}  ${spec.description}`;
		})
		.filter(Boolean);

	// Command-specific subactions
	let subactionLines = "";
	if (canonical === "scratchpad") {
		subactionLines = `\nActions:\n${SCRATCHPAD_ACTIONS.map((a) => `  ${a.padEnd(24)}  ${SCRATCHPAD_ACTION_DESCRIPTIONS[a]}`).join("\n")}\n`;
	}
	if (canonical === "plugin" || canonical === "pro") {
		subactionLines = `\nSubcommands:\n${PLUGIN_COMMANDS.map((a) => `  ${a.padEnd(24)}  ${PLUGIN_COMMAND_DESCRIPTIONS[a]}`).join("\n")}\n`;
	}

	const parts = [`agent-memory ${canonical} — ${description}`, "", "Usage:", `  ${usage}`];
	if (subactionLines) parts.push(subactionLines);
	if (optLines.length) parts.push("\nOptions:", ...optLines);
	if (globalLines.length) parts.push("\nGlobal:", ...globalLines);
	if (examples.length) {
		parts.push("\nExamples:");
		for (const ex of examples) parts.push(`  $ ${ex}`);
	}
	return parts.join("\n");
}
