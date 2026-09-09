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
const SESSION = "qoder-stop-test";
const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

function makeHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-qoder-stop-"));
	createdHomes.push(home);
	fs.mkdirSync(path.join(home, ".qoder"), { recursive: true });
	fs.writeFileSync(path.join(home, ".qoder", "settings.json"), "{}\n", "utf8");
	_setHookHomeDirForTest(home);
	return home;
}

function writeTranscript(home: string, records: unknown[]): string {
	const file = path.join(home, "transcript.jsonl");
	fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	return file;
}

function meta(): unknown {
	return { type: "session_meta", sessionId: SESSION, uuid: "meta", data: { meta_type: "session_info" } };
}

function user(content: unknown, uuid: string): unknown {
	return { type: "user", sessionId: SESSION, uuid, message: { role: "user", content } };
}

function tool(name: string, id: string, input: unknown, content: string, isError = false): unknown[] {
	return [
		{
			type: "assistant",
			sessionId: SESSION,
			uuid: `${id}-call`,
			message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
		},
		user([{ type: "tool_result", tool_use_id: id, content, is_error: isError }], `${id}-result`),
	];
}

function runQoderStop(home: string, transcriptPath: string, stopHookActive = false) {
	return Bun.spawnSync(["bun", "run", CLI, "hook", "stop", "--agent", "qoder", "--dir", path.join(home, "memory")], {
		stdin: Buffer.from(
			JSON.stringify({ session_id: SESSION, transcript_path: transcriptPath, stop_hook_active: stopHookActive }),
		),
		stdout: "pipe",
		stderr: "pipe",
	});
}

afterEach(() => {
	_setHookHomeDirForTest(null);
	for (const home of createdHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("Qoder Stop capture installation", () => {
	test("upgrades a SessionStart-only install with a mode-independent Stop hook", () => {
		const home = makeHome();
		const settingsPath = path.join(home, ".qoder", "settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					hooks: {
						SessionStart: [{ hooks: [{ type: "command", command: "agent-memory context", _agentMemory: true }] }],
					},
				},
				null,
				2,
			),
		);
		expect(isHookInstalled(home, "qoder")).toBe(false);
		expect(isStopHookInstalled(home, "qoder")).toBe(false);

		const upgraded = installHooks(new Set(["qoder"]), "stable");
		expect(upgraded.results[0]?.installed).toBe(true);
		expect(upgraded.results[0]?.reason).toBe("updated");
		expect(isHookInstalled(home, "qoder")).toBe(true);
		expect(isStopHookInstalled(home, "qoder")).toBe(true);
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		expect(settings.hooks.Stop[0].hooks[0].command).toBe("agent-memory hook stop --agent qoder");

		const idempotent = installHooks(new Set(["qoder"]), "per-turn");
		expect(idempotent.results[0]?.installed).toBe(false);
		expect(idempotent.results[0]?.reason).toBe("already installed");
	});

	test("uninstall removes only AgentMemory Qoder hooks and preserves unrelated hooks", () => {
		const home = makeHome();
		const settingsPath = path.join(home, ".qoder", "settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }] } }, null, 2),
		);
		installHooks(new Set(["qoder"]), "stable");
		const removed = uninstallHooks(new Set(["qoder"]));
		expect(removed.results[0]?.installed).toBe(true);
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		expect(settings.hooks.Stop).toHaveLength(1);
		expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo unrelated");
	});

	test("real Core Stop path blocks with exit 2/stderr and prevents immediate re-entry", () => {
		const home = makeHome();
		const transcript = writeTranscript(home, [
			meta(),
			...tool("search_replace", "edit-1", { file_path: "/repo/a.ts" }, "Updated"),
		]);
		const first = runQoderStop(home, transcript);
		expect(first.exitCode).toBe(2);
		expect(first.stdout.toString()).toBe("");
		expect(first.stderr.toString()).toContain("capture it now");
		const second = runQoderStop(home, transcript);
		expect(second.exitCode).toBe(0);
		expect(second.stderr.toString()).toBe("");
		const reentry = runQoderStop(home, transcript, true);
		expect(reentry.exitCode).toBe(0);
		expect(reentry.stderr.toString()).toBe("");
	});

	test("failed edits do not create a pending Qoder capture signal", () => {
		const home = makeHome();
		const transcript = writeTranscript(home, [meta(), ...tool("search_replace", "edit-1", {}, "failed", true)]);
		const result = runQoderStop(home, transcript);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
	});

	test("verified AgentMemory terminal write clears the Qoder pending signal", () => {
		const home = makeHome();
		const transcript = writeTranscript(home, [
			meta(),
			...tool("create_file", "edit-1", { file_path: "/repo/a.ts" }, "Created"),
			...tool(
				"run_in_terminal",
				"write-1",
				{ command: 'agent-memory write --content "remembered"' },
				"Appended to daily log: /memory/daily/2026-09-08.md",
			),
		]);
		const result = runQoderStop(home, transcript);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
	});
});
