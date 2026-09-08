import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_setHookHomeDirForTest,
	installHooks,
	isHookInstalled,
	isStopHookInstalled,
	isUserPromptSubmitInstalled,
	uninstallHooks,
} from "../src/hooks.js";

const createdHomes: string[] = [];
const SESSION = "11111111-2222-3333-4444-555555555555";
const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

function makeHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-codex-stop-"));
	createdHomes.push(home);
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "config.toml"), "", "utf8");
	_setHookHomeDirForTest(home);
	return home;
}

function writeRollout(home: string, items: unknown[]): string {
	const file = path.join(home, "rollout.jsonl");
	fs.writeFileSync(file, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
	return file;
}

function codexMeta(): unknown {
	return {
		timestamp: "2026-09-08T22:00:00Z",
		type: "session_meta",
		payload: { session_id: SESSION, id: SESSION, cwd: "/repo", source: "cli" },
	};
}

function patchExchange(): unknown[] {
	return [
		{
			timestamp: "2026-09-08T22:00:01Z",
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "apply_patch",
				call_id: "patch-1",
				arguments: "*** Begin Patch\n*** End Patch",
			},
		},
		{
			timestamp: "2026-09-08T22:00:02Z",
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "patch-1",
				output: { content: "Done!", success: true },
			},
		},
	];
}

function verifiedWriteExchange(): unknown[] {
	return [
		{
			timestamp: "2026-09-08T22:00:03Z",
			type: "response_item",
			payload: {
				type: "function_call",
				name: "exec_command",
				call_id: "write-1",
				arguments: JSON.stringify({ cmd: 'agent-memory write --content "staging uses PostgreSQL"' }),
			},
		},
		{
			timestamp: "2026-09-08T22:00:04Z",
			type: "response_item",
			payload: {
				type: "function_call_output",
				call_id: "write-1",
				output: {
					content:
						"Chunk ID: abc\nProcess exited with code 0\nFinal output:\nAppended to daily log: /memory/daily/2026-09-08.md",
					success: true,
				},
			},
		},
	];
}

function runCodexStop(home: string, transcriptPath: string, stopHookActive = false) {
	return Bun.spawnSync(["bun", "run", CLI, "hook", "stop", "--agent", "codex", "--dir", path.join(home, "memory")], {
		stdin: Buffer.from(
			JSON.stringify({
				session_id: SESSION,
				transcript_path: transcriptPath,
				stop_hook_active: stopHookActive,
			}),
		),
		stdout: "pipe",
		stderr: "pipe",
	});
}

afterEach(() => {
	_setHookHomeDirForTest(null);
	for (const home of createdHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("Codex Stop capture installation", () => {
	test("upgrades an older Codex hook block and keeps Stop across hook modes", () => {
		const home = makeHome();
		const configPath = path.join(home, ".codex", "config.toml");
		fs.writeFileSync(
			configPath,
			[
				"# BEGIN agent-memory hook",
				"[[hooks.SessionStart]]",
				'matcher = "startup|resume"',
				"",
				"[[hooks.SessionStart.hooks]]",
				'type = "command"',
				'command = "agent-memory hook session-start --agent codex"',
				"",
				"[[hooks.UserPromptSubmit]]",
				"",
				"[[hooks.UserPromptSubmit.hooks]]",
				'type = "command"',
				'command = "agent-memory hook user-prompt-submit --agent codex"',
				"# END agent-memory hook",
				"",
			].join("\n"),
			"utf8",
		);

		expect(isHookInstalled(home, "codex")).toBe(false);
		expect(isStopHookInstalled(home, "codex")).toBe(false);

		const upgraded = installHooks(new Set(["codex"]), "per-turn");
		expect(upgraded.results[0]?.installed).toBe(true);
		expect(upgraded.results[0]?.reason).toBe("updated");
		expect(isHookInstalled(home, "codex")).toBe(true);
		expect(isUserPromptSubmitInstalled(home, "codex")).toBe(true);
		expect(isStopHookInstalled(home, "codex")).toBe(true);
		const upgradedConfig = fs.readFileSync(configPath, "utf8");
		expect(upgradedConfig).toContain("[[hooks.Stop]]");
		expect(upgradedConfig).toContain('command = "agent-memory hook stop --agent codex"');

		const stable = installHooks(new Set(["codex"]), "stable");
		expect(stable.results[0]?.installed).toBe(true);
		expect(isHookInstalled(home, "codex")).toBe(true);
		expect(isUserPromptSubmitInstalled(home, "codex")).toBe(false);
		expect(isStopHookInstalled(home, "codex")).toBe(true);

		const idempotent = installHooks(new Set(["codex"]), "stable");
		expect(idempotent.results[0]?.installed).toBe(false);
		expect(idempotent.results[0]?.reason).toBe("already installed");
	});

	test("uninstall removes the complete managed Codex hook block", () => {
		const home = makeHome();
		installHooks(new Set(["codex"]), "per-turn");
		const removed = uninstallHooks(new Set(["codex"]));
		expect(removed.results[0]?.installed).toBe(true);
		expect(isStopHookInstalled(home, "codex")).toBe(false);
		expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).not.toContain(
			"# BEGIN agent-memory hook",
		);
	});

	test("real Core Stop path emits Codex block/reason for completed work and prevents immediate re-entry", () => {
		const home = makeHome();
		const transcript = writeRollout(home, [codexMeta(), ...patchExchange()]);
		const first = runCodexStop(home, transcript);
		expect(first.exitCode).toBe(0);
		expect(JSON.parse(first.stdout.toString())).toEqual({
			decision: "block",
			reason: expect.stringContaining("capture it now"),
		});
		expect(runCodexStop(home, transcript).stdout.toString()).toBe("");
		expect(runCodexStop(home, transcript, true).stdout.toString()).toBe("");
	});

	test("verified AgentMemory write clears the real Codex Stop pending signal", () => {
		const home = makeHome();
		const transcript = writeRollout(home, [codexMeta(), ...patchExchange(), ...verifiedWriteExchange()]);
		const result = runCodexStop(home, transcript);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
	});
});
