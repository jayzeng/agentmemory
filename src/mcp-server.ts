import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// MCP tool definition and handler types
// ---------------------------------------------------------------------------

export interface McpToolInputSchema {
	type: "object";
	properties: Record<string, { type: string; description?: string; enum?: string[] }>;
	required?: string[];
}

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: McpToolInputSchema;
}

export type McpToolHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Bare stdio MCP server — no external dependencies
//
// MCP uses newline-delimited JSON-RPC 2.0 over stdin/stdout (NOT Content-Length
// framing). Each message is one JSON object followed by \n.
// ---------------------------------------------------------------------------

export class StdioMcpServer {
	private readonly tools = new Map<string, { definition: McpToolDefinition; handler: McpToolHandler }>();
	private readonly startupHooks: Array<() => void | Promise<void>> = [];
	private readonly shutdownHooks: Array<() => void | Promise<void>> = [];

	constructor(private readonly version = "0.0.0") {}

	addTool(definition: McpToolDefinition, handler: McpToolHandler): void {
		this.tools.set(definition.name, { definition, handler });
	}

	addStartupHook(fn: () => void | Promise<void>): void {
		this.startupHooks.push(fn);
	}

	addShutdownHook(fn: () => void | Promise<void>): void {
		this.shutdownHooks.push(fn);
	}

	async start(): Promise<void> {
		// Run all startup hooks before entering the message loop.
		for (const hook of this.startupHooks) await hook();

		const rl = readline.createInterface({ input: process.stdin, terminal: false });

		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let message: unknown;
			try {
				message = JSON.parse(trimmed);
			} catch {
				return;
			}
			this.handleMessage(message as Record<string, unknown>);
		});

		await new Promise<void>((resolve) => {
			rl.on("close", resolve);
			process.stdin.on("end", resolve);
		});

		// A hook may hold resources (e.g. fs.watch handles) that keep the event
		// loop alive past stdin close — run them, but don't let one broken hook
		// block the others or block process exit.
		for (const hook of this.shutdownHooks) {
			try {
				await hook();
			} catch {
				// Non-fatal — the caller still hard-exits after start() returns.
			}
		}
	}

	private handleMessage(msg: Record<string, unknown>): void {
		const id = msg.id as string | number | null | undefined;
		const method = typeof msg.method === "string" ? msg.method : "";

		// Notifications (no id) — no response needed.
		if (id === undefined || id === null) {
			// notifications/initialized is the only one we care about; ignore the rest.
			return;
		}

		if (method === "initialize") {
			this.respond(id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "agent-memory", version: this.version },
			});
			return;
		}

		if (method === "ping") {
			this.respond(id, {});
			return;
		}

		if (method === "tools/list") {
			this.respond(id, {
				tools: [...this.tools.values()].map(({ definition }) => definition),
			});
			return;
		}

		if (method === "tools/call") {
			const params = (msg.params ?? {}) as Record<string, unknown>;
			const toolName = typeof params.name === "string" ? params.name : "";
			const toolInput = (params.arguments ?? {}) as Record<string, unknown>;

			const entry = this.tools.get(toolName);
			if (!entry) {
				this.respondError(id, -32601, `Unknown tool: ${toolName}`);
				return;
			}

			// Execute handler — handle both sync and async.
			Promise.resolve()
				.then(() => entry.handler(toolInput))
				.then((result) => {
					this.respond(id, {
						content: [
							{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
						],
					});
				})
				.catch((error: unknown) => {
					this.respond(id, {
						content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
						isError: true,
					});
				});
			return;
		}

		// Unknown method — JSON-RPC method not found.
		this.respondError(id, -32601, `Method not found: ${method}`);
	}

	private respond(id: string | number, result: unknown): void {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	private respondError(id: string | number, code: number, message: string): void {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
	}
}
