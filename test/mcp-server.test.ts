/**
 * Tests for `agent-memory serve --mcp` (src/mcp-server.ts).
 *
 * Two layers:
 *  - Unit: call each tool's .run() directly against a temp memory dir.
 *  - Integration: spawn the real stdio JSON-RPC transport as a child
 *    process and drive it with newline-delimited JSON, the same way a real
 *    MCP client (or the poc-chatgpt-relay relay client) would.
 *
 * Run: bun test test/mcp-server.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_resetBaseDir,
	_resetExecFileForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	readFileSafe,
} from "../src/core.js";
import { _internalToolsForTest } from "../src/mcp-server.js";

let tmpDir: string;

function tool(name: string) {
	const found = _internalToolsForTest.find((t) => t.name === name);
	if (!found) throw new Error(`tool not found: ${name}`);
	return found;
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-mcp-test-"));
	_setBaseDir(tmpDir);
	_setQmdAvailable(false);
});

afterEach(() => {
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcp tools (unit)", () => {
	test("memory_write then memory_read round-trips long_term content", async () => {
		const writeResult = await tool("memory_write").run({
			target: "long_term",
			content: "Decision: use Postgres for the ledger.",
			mode: "append",
		});
		expect(writeResult.isError).toBeFalsy();

		const readResult = await tool("memory_read").run({ target: "long_term" });
		expect(readResult.text).toContain("Decision: use Postgres for the ledger.");
	});

	test("memory_write rejects missing content", async () => {
		const result = await tool("memory_write").run({ target: "daily" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("content");
	});

	test("memory_read rejects an invalid target", async () => {
		const result = await tool("memory_read").run({ target: "not-a-real-target" });
		expect(result.isError).toBe(true);
	});

	test("memory_scratchpad add/list/done round-trips", async () => {
		const added = await tool("memory_scratchpad").run({ action: "add", text: "Ship the relay" });
		expect(added.isError).toBeFalsy();

		const listed = await tool("memory_scratchpad").run({ action: "list" });
		expect(listed.text).toContain("Ship the relay");

		const done = await tool("memory_scratchpad").run({ action: "done", text: "relay" });
		expect(done.isError).toBeFalsy();

		const listedAfter = await tool("memory_scratchpad").run({ action: "list" });
		expect(listedAfter.text).toContain("[x] Ship the relay");
	});

	test("memory_context with noSearch returns the base context block without invoking search", async () => {
		await tool("memory_write").run({ target: "long_term", content: "Fixture memory.", mode: "append" });
		const result = await tool("memory_context").run({ noSearch: "true" });
		expect(result.text).toContain("Fixture memory.");
	});

	test("memory_search fails clearly when qmd is unavailable, without touching real network/data", async () => {
		// Force `qmd status` to fail deterministically instead of depending on
		// whether qmd happens to be installed on the machine running the test.
		_setExecFileForTest(((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
			cb(new Error("qmd: command not found"));
		}) as never);
		try {
			const result = await tool("memory_search").run({ query: "anything" });
			expect(result.isError).toBe(true);
			expect(result.text.toLowerCase()).toContain("qmd");
		} finally {
			_resetExecFileForTest();
		}
	});

	test("memory_search rejects an invalid mode before touching qmd", async () => {
		const result = await tool("memory_search").run({ query: "anything", mode: "bogus" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("mode");
	});

	test("secrets are redacted the same way as the CLI write path", async () => {
		const result = await tool("memory_write").run({
			target: "daily",
			content: "API key: sk-live-abcdef1234567890abcdef1234567890",
		});
		expect(result.isError).toBeFalsy();
		const stored = readFileSafe(path.join(tmpDir, "daily", `${new Date().toISOString().slice(0, 10)}.md`));
		expect(stored).not.toContain("sk-live-abcdef1234567890abcdef1234567890");
	});
});

describe("mcp stdio transport (integration)", () => {
	function sendAndCollect(lines: object[], env: Record<string, string>): Promise<any[]> {
		return new Promise((resolve, reject) => {
			const child = spawn("bun", ["run", path.join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--mcp"], {
				env: { ...process.env, ...env },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", () => {
				try {
					const responses = stdout
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean)
						.map((line) => JSON.parse(line));
					resolve(responses);
				} catch (err) {
					reject(new Error(`Failed to parse responses. stderr=${stderr} stdout=${stdout} err=${err}`));
				}
			});
			for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
			child.stdin.end();
		});
	}

	test("initialize -> tools/list -> tools/call round-trip over real stdio JSON-RPC", async () => {
		const responses = await sendAndCollect(
			[
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
				{
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "memory_scratchpad", arguments: { action: "list" } },
				},
			],
			{ AGENT_MEMORY_DIR: tmpDir },
		);

		const byId = new Map(responses.map((r) => [r.id, r]));
		expect(byId.get(1)?.result?.protocolVersion).toBe("2025-03-26");
		expect(byId.get(2)?.result?.tools?.map((t: any) => t.name)).toContain("memory_search");
		expect(byId.get(3)?.result?.content?.[0]?.text).toContain("Scratchpad is empty");
	});

	test("unknown tool name returns a JSON-RPC error, not a crash", async () => {
		const responses = await sendAndCollect(
			[{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "does_not_exist", arguments: {} } }],
			{ AGENT_MEMORY_DIR: tmpDir },
		);
		expect(responses[0]?.error?.code).toBe(-32602);
	});

	test("malformed JSON line returns a parse error instead of hanging the transport", async () => {
		const responses = await new Promise<any[]>((resolve, reject) => {
			const child = spawn("bun", ["run", path.join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--mcp"], {
				env: { ...process.env, AGENT_MEMORY_DIR: tmpDir },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", () => {
				resolve(
					stdout
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean)
						.map((l) => JSON.parse(l)),
				);
			});
			child.stdin.write("{not json\n");
			child.stdin.end();
		});
		expect(responses[0]?.error?.code).toBe(-32700);
	});
});
