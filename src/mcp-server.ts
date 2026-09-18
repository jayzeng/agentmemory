/**
 * agent-memory MCP server (`agent-memory serve --mcp`)
 *
 * A real Model Context Protocol server over the stdio transport
 * (https://modelcontextprotocol.io/specification — 2025-03-26 "stdio
 * transport" + "tools" primitive). One JSON-RPC 2.0 message per line on
 * stdin/stdout, no framing headers, stderr reserved for diagnostics/logs
 * (never JSON-RPC).
 *
 * This is the piece the local-context-handoff HTML's §10b and the
 * poc-chatgpt-relay POC both assumed already existed and both found does
 * not: agentmemory/src/cli.ts had no `serve` subcommand, and
 * agent-memory-plugin/src/bundle.ts's `registerMcpTool` hooks had no host
 * implementation anywhere that actually spoke MCP over a transport. This
 * file is that host, for the public MIT core's five tools. The relay in
 * ../../poc-chatgpt-relay spawns this exact file as a subprocess and
 * forwards ChatGPT-originated MCP frames to its stdin, so any tool added
 * here is automatically reachable from ChatGPT once the relay side is
 * deployed — no relay-side changes needed for new tools.
 *
 * Deliberately dependency-free (no @modelcontextprotocol/sdk) to keep the
 * public core's install footprint small; the protocol surface used here
 * (initialize, notifications/initialized, tools/list, tools/call, ping) is
 * small enough to hand-roll and test directly.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";

import {
	buildMemoryContext,
	checkCollection,
	dailyPath,
	detectQmd,
	ensureDirs,
	ensureQmdAvailableForSync,
	ensureQmdAvailableForUpdate,
	getCollectionName,
	getDailyDir,
	getMemoryFile,
	getQmdResultPath,
	getQmdResultText,
	getScratchpadFile,
	getTopicsDir,
	memoryWrite,
	nowTimestamp,
	parseScratchpad,
	readFileSafe,
	redactSecrets,
	runQmdSearch,
	scheduleQmdUpdate,
	searchRelevantMemories,
	serializeScratchpad,
	slugifyTopic,
	todayStr,
	topicPath,
} from "./core.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "agent-memory";

declare const __VERSION__: string;
function serverVersion(): string {
	try {
		return typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
	} catch {
		return "dev";
	}
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: string | number | null;
	result: unknown;
}

interface JsonRpcError {
	jsonrpc: "2.0";
	id: string | number | null;
	error: { code: number; message: string; data?: unknown };
}

function writeMessage(message: JsonRpcSuccess | JsonRpcError) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id: string | number | null, result: unknown) {
	writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id: string | number | null, code: number, message: string, data?: unknown) {
	writeMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
}

// Standard JSON-RPC error codes (spec §5.1) plus MCP's convention of using
// -32602 (Invalid params) for tool-input validation failures.
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

interface ToolInputSchema {
	type: "object";
	properties: Record<string, { type: string; description?: string; enum?: string[] }>;
	required?: string[];
}

interface McpTool {
	name: string;
	description: string;
	inputSchema: ToolInputSchema;
	// Returns MCP "tool result content" — an array of content blocks. Text
	// only for now; this is the same shape ChatGPT/ any MCP client renders.
	run(input: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
}

function textResult(text: string, isError = false) {
	return { isError, text };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

const memoryContextTool: McpTool = {
	name: "memory_context",
	description:
		"Build and return the injectable AgentMemory context block (long-term memory, recent daily logs, scratchpad, topics), optionally scoped by a search query. This is the same content a harness would inject at session start.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Optional search query to scope relevant-memory retrieval" },
			noSearch: { type: "string", description: "'true' to skip the search step and return just the base context" },
		},
	},
	async run(input) {
		ensureDirs();
		const query = asString(input.query) ?? "";
		const noSearch = asString(input.noSearch) === "true";
		if (!noSearch && query) await ensureQmdAvailableForSync();
		const searchResults = noSearch ? "" : await searchRelevantMemories(query);
		const context = buildMemoryContext(searchResults);
		return textResult(context || "(no memory context available)");
	},
};

const memorySearchTool: McpTool = {
	name: "memory_search",
	description:
		"Search AgentMemory content (MEMORY.md, SCRATCHPAD.md, daily logs, topics) via qmd. Modes: keyword (fast, exact terms), semantic (meaning-based), deep (hybrid + rerank, slower).",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search query" },
			mode: { type: "string", enum: ["keyword", "semantic", "deep"], description: "Default: keyword" },
			limit: { type: "string", description: "Max results, default 5" },
		},
		required: ["query"],
	},
	async run(input) {
		const query = asString(input.query);
		if (!query) return textResult("Error: 'query' is required.", true);
		const mode = (asString(input.mode) ?? "keyword") as "keyword" | "semantic" | "deep";
		if (!["keyword", "semantic", "deep"].includes(mode)) {
			return textResult("Error: 'mode' must be 'keyword', 'semantic', or 'deep'.", true);
		}
		const limit = Number.parseInt(asString(input.limit) ?? "5", 10) || 5;

		const qmdFound = await detectQmd();
		if (!qmdFound) {
			return textResult(
				"Error: qmd is not installed on this machine. Install: bun install -g https://github.com/tobi/qmd",
				true,
			);
		}
		const collName = getCollectionName();
		if (!(await checkCollection(collName))) {
			return textResult(`Error: qmd collection '${collName}' not found. Run: agent-memory init`, true);
		}

		try {
			const { results, stderr } = await runQmdSearch(mode, query, limit);
			if (results.length === 0) {
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				if (needsEmbed && (mode === "semantic" || mode === "deep")) {
					return textResult("No results found. qmd reports missing embeddings — run: qmd embed");
				}
				return textResult(`No results found for "${query}" (mode: ${mode}).`);
			}
			const blocks = results.map((r, i) => {
				const filePath = getQmdResultPath(r);
				const text = getQmdResultText(r);
				const lines = [`--- Result ${i + 1} ---`];
				if (filePath) lines.push(`File: ${filePath}`);
				if (r.score != null) lines.push(`Score: ${r.score}`);
				if (text) lines.push(text);
				return lines.join("\n");
			});
			return textResult(blocks.join("\n\n"));
		} catch (err) {
			return textResult(`Error: search failed: ${err instanceof Error ? err.message : String(err)}`, true);
		}
	},
};

const memoryReadTool: McpTool = {
	name: "memory_read",
	description:
		"Read a specific AgentMemory file: long-term memory, scratchpad, a daily log, a topic file, or list daily logs/topics.",
	inputSchema: {
		type: "object",
		properties: {
			target: { type: "string", enum: ["long_term", "scratchpad", "daily", "list", "topic", "topics"] },
			date: { type: "string", description: "YYYY-MM-DD, used with target=daily (default: today)" },
			topic: { type: "string", description: "Topic name, used with target=topic" },
		},
		required: ["target"],
	},
	async run(input) {
		const target = asString(input.target);
		if (!target || !["long_term", "scratchpad", "daily", "list", "topic", "topics"].includes(target)) {
			return textResult(
				"Error: 'target' must be 'long_term', 'scratchpad', 'daily', 'list', 'topic', or 'topics'.",
				true,
			);
		}
		ensureDirs();

		if (target === "list") {
			try {
				const files = fs
					.readdirSync(getDailyDir())
					.filter((f) => f.endsWith(".md"))
					.sort()
					.reverse();
				return textResult(
					files.length ? `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}` : "No daily logs found.",
				);
			} catch {
				return textResult("No daily logs directory.");
			}
		}
		if (target === "topics") {
			try {
				const files = fs
					.readdirSync(getTopicsDir())
					.filter((f) => f.endsWith(".md"))
					.sort()
					.reverse();
				return textResult(files.length ? `Topics:\n${files.map((f) => `- ${f}`).join("\n")}` : "No topics found.");
			} catch {
				return textResult("No topics directory.");
			}
		}
		if (target === "daily") {
			const d = asString(input.date) ?? todayStr();
			const content = readFileSafe(dailyPath(d));
			return textResult(content ?? `No daily log for ${d}.`);
		}
		if (target === "topic") {
			const topic = asString(input.topic);
			if (!topic) return textResult("Error: 'topic' is required when target is 'topic'.", true);
			const content = readFileSafe(topicPath(slugifyTopic(topic)));
			return textResult(content ?? `No topic file found for ${topic}.`);
		}
		if (target === "scratchpad") {
			const content = readFileSafe(getScratchpadFile());
			return textResult(content?.trim() ? content : "SCRATCHPAD.md is empty or does not exist.");
		}
		const content = readFileSafe(getMemoryFile());
		return textResult(content ?? "MEMORY.md is empty or does not exist.");
	},
};

const memoryWriteTool: McpTool = {
	name: "memory_write",
	description:
		"Write to AgentMemory: append/overwrite the long-term MEMORY.md, today's daily log, or a named topic file. Secrets are redacted automatically.",
	inputSchema: {
		type: "object",
		properties: {
			target: { type: "string", enum: ["long_term", "daily", "topic"], description: "Default: daily" },
			content: { type: "string" },
			mode: { type: "string", enum: ["append", "overwrite"], description: "Default: append" },
			topic: { type: "string", description: "Required when target=topic" },
			date: { type: "string", description: "YYYY-MM-DD, used with target=daily" },
			sourceUri: { type: "string", description: "Optional provenance link for this entry" },
		},
		required: ["content"],
	},
	async run(input) {
		const content = asString(input.content);
		if (!content) return textResult("Error: 'content' is required.", true);
		const target = (asString(input.target) ?? "daily") as "long_term" | "daily" | "topic";
		if (!["long_term", "daily", "topic"].includes(target)) {
			return textResult("Error: 'target' must be 'long_term', 'daily', or 'topic'.", true);
		}
		const mode = (asString(input.mode) ?? "append") as "append" | "overwrite";
		if (!["append", "overwrite"].includes(mode)) {
			return textResult("Error: 'mode' must be 'append' or 'overwrite'.", true);
		}
		const result = await memoryWrite({
			target,
			content,
			mode,
			sessionId: "mcp",
			topic: asString(input.topic),
			date: asString(input.date),
			sourceUri: asString(input.sourceUri),
		});
		return textResult(result.text, result.isError === true);
	},
};

const memoryScratchpadTool: McpTool = {
	name: "memory_scratchpad",
	description:
		"Manage the AgentMemory scratchpad checklist: add an item, mark done/undo, clear done items, or list all items.",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["add", "done", "undo", "clear_done", "list"] },
			text: { type: "string", description: "Item text (add) or substring to match (done/undo)" },
		},
		required: ["action"],
	},
	async run(input) {
		const action = asString(input.action);
		if (!action || !["add", "done", "undo", "clear_done", "list"].includes(action)) {
			return textResult("Error: 'action' must be 'add', 'done', 'undo', 'clear_done', or 'list'.", true);
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
			return textResult(items.length ? serializeScratchpad(items) : "Scratchpad is empty.");
		}
		if (action === "add") {
			const text = asString(input.text);
			if (!text) return textResult("Error: 'text' is required for action 'add'.", true);
			const ts = nowTimestamp();
			const safeText = redactSecrets(text).content;
			items.push({ done: false, text: safeText, meta: `<!-- ${ts} [mcp] -->` });
			fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return textResult(`Added: - [ ] ${safeText}`);
		}
		if (action === "done" || action === "undo") {
			const text = asString(input.text);
			if (!text) return textResult(`Error: 'text' is required for action '${action}'.`, true);
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
			if (!matched) return textResult(`No matching ${targetDone ? "open" : "done"} item found for: "${text}"`, true);
			fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return textResult("Updated.");
		}
		// clear_done
		const before = items.length;
		items = items.filter((i) => !i.done);
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		return textResult(`Cleared ${before - items.length} done item(s).`);
	},
};

const TOOLS: McpTool[] = [memoryContextTool, memorySearchTool, memoryReadTool, memoryWriteTool, memoryScratchpadTool];
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleRequest(request: JsonRpcRequest) {
	const id = request.id ?? null;

	switch (request.method) {
		case "initialize":
			ok(id, {
				protocolVersion: PROTOCOL_VERSION,
				serverInfo: { name: SERVER_NAME, version: serverVersion() },
				capabilities: { tools: {} },
			});
			return;

		case "ping":
			ok(id, {});
			return;

		case "tools/list":
			ok(id, {
				tools: TOOLS.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
				})),
			});
			return;

		case "tools/call": {
			const params = request.params ?? {};
			const toolName = asString(params.name);
			const args = (params.arguments as Record<string, unknown>) ?? {};
			if (!toolName) {
				fail(id, INVALID_PARAMS, "Missing required param 'name'.");
				return;
			}
			const tool = TOOLS_BY_NAME.get(toolName);
			if (!tool) {
				fail(id, INVALID_PARAMS, `Unknown tool: ${toolName}`);
				return;
			}
			try {
				const result = await tool.run(args);
				ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError === true });
			} catch (err) {
				fail(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
			}
			return;
		}

		default:
			// Notifications (no id) that we don't recognize are silently
			// ignored per spec; requests with an id get a proper error.
			if (id !== null) fail(id, METHOD_NOT_FOUND, `Method not found: ${request.method}`);
	}
}

// ---------------------------------------------------------------------------
// stdio transport: one JSON-RPC message per line
// ---------------------------------------------------------------------------

export function runMcpServer() {
	ensureDirs();
	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	// stdin EOF (rl 'close') can fire while tool calls from earlier lines are
	// still in flight — every tool handler is async (qmd calls, fs writes with
	// awaited follow-ups). Track in-flight promises so process.exit() never
	// races ahead of a response that's still being written to stdout; without
	// this, calls near end-of-stream silently vanish (no JSON-RPC response,
	// not even an error) rather than reaching the client.
	const pending = new Set<Promise<void>>();
	let closed = false;

	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let request: JsonRpcRequest;
		try {
			request = JSON.parse(trimmed) as JsonRpcRequest;
		} catch {
			fail(null, PARSE_ERROR, "Invalid JSON.");
			return;
		}
		const task = handleRequest(request)
			.catch((err) => {
				fail(request.id ?? null, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				pending.delete(task);
				if (closed && pending.size === 0) process.exit(0);
			});
		pending.add(task);
	});

	rl.on("close", () => {
		closed = true;
		if (pending.size === 0) process.exit(0);
	});

	// stdin closing is the client's normal shutdown signal for the stdio
	// transport. Never write logs to stdout — it is JSON-RPC-only; stderr is
	// safe for diagnostics if ever needed.
	process.stdin.resume();
}

export { TOOLS as _internalToolsForTest };
