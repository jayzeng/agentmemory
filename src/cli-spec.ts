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
	"write",
	"read",
	"scratchpad",
	"search",
	"distil",
	"sync",
	"init",
	"status",
	"install-skills",
	"uninstall-skills",
	"install-hooks",
	"uninstall-hooks",
	"completion",
	"plugin",
	"version",
	"help",
] as const;

export const PLUGIN_COMMANDS = ["list", "status", "install", "update", "uninstall", "manage"] as const;

export const WORKER_ACTIONS = [] as const;
export const SCRATCHPAD_ACTIONS = ["add", "done", "undo", "clear_done", "list"] as const;

export const COMMAND_DESCRIPTIONS: Record<(typeof COMMANDS)[number], string> = {
	context: "build context from scratchpad, logs, topics, and long-term memory",
	write: "append or overwrite a daily, topic, or long-term memory entry",
	read: "read daily, topic, scratchpad, or long-term memory",
	scratchpad: "add, complete, reopen, list, or clear persistent checklist items",
	search: "search indexed memory with keyword, semantic, or deep qmd modes",
	distil: "rebuild a compact MEMORY.md index from logs and topics",
	sync: "update the qmd index and semantic embeddings",
	init: "create memory storage and configure qmd when available",
	status: "show memory paths, file counts, qmd, and embedding health",
	"install-skills": "install core instructions for detected agents",
	"uninstall-skills": "remove core instructions from detected agents",
	"install-hooks": "install automatic SessionStart indexing and context hooks",
	"uninstall-hooks": "remove only SessionStart hooks managed by agent-memory",
	completion: "install or print Bash, Zsh, Fish, or PowerShell completion",
	plugin: "index, recall, learn from, and evaluate prior agent sessions",
	version: "print the installed agent-memory version",
	help: "show top-level, command, or nested plugin help",
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
	context: ["--query", "--no-search"],
	write: ["--content", "--target", "--mode", "--topic", "--date", "--source-uri"],
	read: ["--target", "--date", "--topic"],
	scratchpad: ["--text"],
	search: ["--query", "--mode", "--limit"],
	distil: ["--dry-run"],
	sync: [],
	init: [],
	status: ["--probe"],
	"install-skills": [],
	"uninstall-skills": [],
	"install-hooks": ["--yes", "--all", "--only"],
	"uninstall-hooks": ["--only"],
	completion: ["--stdout"],
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
	"--mode": { description: "write behavior or qmd search strategy", value: { label: "mode", kind: "value" } },
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
	"--yes": { description: "apply eligible hook changes without confirmation" },
	"--all": { description: "apply eligible hook changes without confirmation" },
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
