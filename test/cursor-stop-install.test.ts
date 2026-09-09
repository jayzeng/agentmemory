import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_setHookHomeDirForTest,
	installHooks,
	isHookInstalled,
	isStopHookInstalled,
	uninstallHooks,
} from "../src/hooks.js";

const createdHomes: string[] = [];
const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const CAPTURE_COMMAND = "agent-memory hook cursor-event --agent cursor";

function makeHome(existingHooks: Record<string, unknown> = {}): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-cursor-stop-"));
	createdHomes.push(home);
	fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".cursor", "hooks.json"),
		`${JSON.stringify({ version: 1, hooks: existingHooks }, null, 2)}\n`,
		"utf8",
	);
	_setHookHomeDirForTest(home);
	return home;
}

function runCursorEvent(home: string, payload: Record<string, unknown>) {
	return Bun.spawnSync(
		["bun", "run", CLI, "hook", "cursor-event", "--agent", "cursor", "--dir", path.join(home, "memory")],
		{
			stdin: Buffer.from(JSON.stringify(payload)),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

function basePayload(conversationId: string, event: string): Record<string, unknown> {
	return {
		conversation_id: conversationId,
		generation_id: `${conversationId}-generation`,
		hook_event_name: event,
		cursor_version: "1.7.2",
		workspace_roots: ["/repo"],
	};
}

function eventCommands(config: Record<string, unknown>, event: string): string[] {
	const hooks = config.hooks && typeof config.hooks === "object" ? (config.hooks as Record<string, unknown>) : {};
	const entries = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
	return entries
		.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
		.map((entry) => String(entry.command ?? ""));
}

afterEach(() => {
	_setHookHomeDirForTest(null);
	for (const home of createdHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("Cursor event-driven capture installation", () => {
	test("upgrades SessionStart-only installs, preserves unrelated hooks, and is idempotent", () => {
		const home = makeHome({
			sessionStart: [{ command: "hooks/agent-memory-session-start.js" }],
			afterFileEdit: [{ command: "./hooks/my-formatter.sh" }],
		});
		expect(isHookInstalled(home, "cursor")).toBe(false);

		const installed = installHooks(new Set(["cursor"]), "per-turn");
		expect(installed.results[0]?.installed).toBe(true);
		expect(isHookInstalled(home, "cursor")).toBe(true);
		expect(isStopHookInstalled(home, "cursor")).toBe(true);

		const config = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8")) as Record<
			string,
			unknown
		>;
		for (const event of ["beforeSubmitPrompt", "afterFileEdit", "afterShellExecution", "afterMCPExecution", "stop"]) {
			expect(eventCommands(config, event)).toContain(CAPTURE_COMMAND);
		}
		expect(eventCommands(config, "afterFileEdit")).toContain("./hooks/my-formatter.sh");

		const second = installHooks(new Set(["cursor"]), "stable");
		expect(second.results[0]?.installed).toBe(false);
		expect(second.results[0]?.reason).toBe("already installed");
	});

	test("uninstall removes only AgentMemory Cursor hooks", () => {
		const home = makeHome({
			afterFileEdit: [{ command: "./hooks/my-formatter.sh" }],
			stop: [{ command: "./hooks/my-stop.sh" }],
		});
		installHooks(new Set(["cursor"]), "per-turn");
		const removed = uninstallHooks(new Set(["cursor"]));
		expect(removed.results[0]?.installed).toBe(true);
		expect(isHookInstalled(home, "cursor")).toBe(false);

		const config = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(eventCommands(config, "afterFileEdit")).toEqual(["./hooks/my-formatter.sh"]);
		expect(eventCommands(config, "stop")).toEqual(["./hooks/my-stop.sh"]);
	});
});

describe("Cursor event-driven capture runtime", () => {
	test("explicit remember request produces one native Stop follow-up", () => {
		const home = makeHome();
		const prompt = runCursorEvent(home, {
			...basePayload("cursor-explicit", "beforeSubmitPrompt"),
			prompt: "Remember this: staging uses PostgreSQL.",
		});
		expect(prompt.exitCode).toBe(0);
		expect(prompt.stdout.toString()).toBe("");

		const first = runCursorEvent(home, {
			...basePayload("cursor-explicit", "stop"),
			status: "completed",
			loop_count: 0,
		});
		expect(first.exitCode).toBe(0);
		expect(JSON.parse(first.stdout.toString())).toEqual({
			followup_message: expect.stringContaining("capture it now"),
		});

		const second = runCursorEvent(home, {
			...basePayload("cursor-explicit", "stop"),
			status: "completed",
			loop_count: 1,
		});
		expect(second.exitCode).toBe(0);
		expect(second.stdout.toString()).toBe("");
	});

	test("negative remember instruction does not create a pending signal", () => {
		const home = makeHome();
		runCursorEvent(home, {
			...basePayload("cursor-negative", "beforeSubmitPrompt"),
			prompt: "Do not remember this: staging uses PostgreSQL.",
		});
		const stop = runCursorEvent(home, {
			...basePayload("cursor-negative", "stop"),
			status: "completed",
			loop_count: 0,
		});
		expect(stop.exitCode).toBe(0);
		expect(stop.stdout.toString()).toBe("");
	});

	test("successful file edit creates a pending capture signal", () => {
		const home = makeHome();
		runCursorEvent(home, {
			...basePayload("cursor-edit", "afterFileEdit"),
			file_path: "/repo/auth.ts",
			edits: [{ old_string: "old", new_string: "new" }],
		});
		const stop = runCursorEvent(home, { ...basePayload("cursor-edit", "stop"), status: "completed", loop_count: 0 });
		expect(JSON.parse(stop.stdout.toString()).followup_message).toContain("capture it now");
	});

	test("verified shell AgentMemory write clears the pending signal", () => {
		const home = makeHome();
		runCursorEvent(home, {
			...basePayload("cursor-shell-clear", "afterFileEdit"),
			file_path: "/repo/auth.ts",
			edits: [{ old_string: "old", new_string: "new" }],
		});
		runCursorEvent(home, {
			...basePayload("cursor-shell-clear", "afterShellExecution"),
			command: 'agent-memory write --content "staging uses PostgreSQL"',
			output: "Appended to daily log: /memory/daily/2026-09-08.md",
			duration: 15,
			sandbox: false,
		});
		const stop = runCursorEvent(home, {
			...basePayload("cursor-shell-clear", "stop"),
			status: "completed",
			loop_count: 0,
		});
		expect(stop.stdout.toString()).toBe("");
	});

	test("verified MCP memory_write clears the pending signal", () => {
		const home = makeHome();
		runCursorEvent(home, {
			...basePayload("cursor-mcp-clear", "afterFileEdit"),
			file_path: "/repo/auth.ts",
			edits: [{ old_string: "old", new_string: "new" }],
		});
		runCursorEvent(home, {
			...basePayload("cursor-mcp-clear", "afterMCPExecution"),
			tool_name: "memory_write",
			tool_input: JSON.stringify({ target: "daily", content: "staging uses PostgreSQL" }),
			mcp_server_name: "agent-memory",
			result_json: JSON.stringify({
				content: [{ type: "text", text: "Appended to daily log: /memory/daily/2026-09-08.md" }],
			}),
			duration: 10,
		});
		const stop = runCursorEvent(home, {
			...basePayload("cursor-mcp-clear", "stop"),
			status: "completed",
			loop_count: 0,
		});
		expect(stop.stdout.toString()).toBe("");
	});

	test("capture state is isolated by conversation and aborted stops fail open", () => {
		const home = makeHome();
		runCursorEvent(home, {
			...basePayload("cursor-a", "beforeSubmitPrompt"),
			prompt: "Remember this: A uses PostgreSQL.",
		});
		const other = runCursorEvent(home, { ...basePayload("cursor-b", "stop"), status: "completed", loop_count: 0 });
		expect(other.stdout.toString()).toBe("");
		const aborted = runCursorEvent(home, { ...basePayload("cursor-a", "stop"), status: "aborted", loop_count: 0 });
		expect(aborted.stdout.toString()).toBe("");
		const own = runCursorEvent(home, { ...basePayload("cursor-a", "stop"), status: "completed", loop_count: 0 });
		expect(JSON.parse(own.stdout.toString()).followup_message).toContain("capture it now");
	});
});
