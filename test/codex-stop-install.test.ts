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

function makeHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-codex-stop-"));
	createdHomes.push(home);
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "config.toml"), "", "utf8");
	_setHookHomeDirForTest(home);
	return home;
}

function adapterPath(home: string): string {
	return path.join(home, ".agent-memory", "hooks", "codex-stop.cjs");
}

function writeFakeAgentMemory(binDir: string, body: string): void {
	fs.mkdirSync(binDir, { recursive: true });
	const executable = path.join(binDir, "agent-memory");
	fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`, "utf8");
	fs.chmodSync(executable, 0o755);
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

		// A pre-Stop install is intentionally unhealthy so setup/doctor can repair it.
		expect(isHookInstalled(home, "codex")).toBe(false);
		expect(isStopHookInstalled(home, "codex")).toBe(false);

		const upgraded = installHooks(new Set(["codex"]), "per-turn");
		expect(upgraded.results[0]?.installed).toBe(true);
		expect(upgraded.results[0]?.reason).toBe("updated");
		expect(isHookInstalled(home, "codex")).toBe(true);
		expect(isUserPromptSubmitInstalled(home, "codex")).toBe(true);
		expect(isStopHookInstalled(home, "codex")).toBe(true);
		expect(fs.existsSync(adapterPath(home))).toBe(true);
		expect(fs.readFileSync(configPath, "utf8")).toContain("[[hooks.Stop]]");

		const stable = installHooks(new Set(["codex"]), "stable");
		expect(stable.results[0]?.installed).toBe(true);
		expect(isHookInstalled(home, "codex")).toBe(true);
		expect(isUserPromptSubmitInstalled(home, "codex")).toBe(false);
		expect(isStopHookInstalled(home, "codex")).toBe(true);

		const idempotent = installHooks(new Set(["codex"]), "stable");
		expect(idempotent.results[0]?.installed).toBe(false);
		expect(idempotent.results[0]?.reason).toBe("already installed");
	});

	test("repairs a tampered adapter and uninstall removes both config and adapter", () => {
		const home = makeHome();
		installHooks(new Set(["codex"]), "per-turn");
		const scriptPath = adapterPath(home);
		fs.writeFileSync(scriptPath, "// stale adapter\n", "utf8");
		expect(isStopHookInstalled(home, "codex")).toBe(false);
		expect(isHookInstalled(home, "codex")).toBe(false);

		const repaired = installHooks(new Set(["codex"]), "per-turn");
		expect(repaired.results[0]?.installed).toBe(true);
		expect(repaired.results[0]?.reason).toBe("updated");
		expect(isStopHookInstalled(home, "codex")).toBe(true);

		const removed = uninstallHooks(new Set(["codex"]));
		expect(removed.results[0]?.installed).toBe(true);
		expect(isStopHookInstalled(home, "codex")).toBe(false);
		expect(fs.existsSync(scriptPath)).toBe(false);
		expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).not.toContain(
			"# BEGIN agent-memory hook",
		);
	});

	test("adapter translates a Core Stop signal to Codex block/reason and fails open", () => {
		const home = makeHome();
		installHooks(new Set(["codex"]), "per-turn");
		const scriptPath = adapterPath(home);
		const binDir = path.join(home, "bin");
		const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
		const input = Buffer.from(
			JSON.stringify({
				session_id: "11111111-2222-3333-4444-555555555555",
				transcript_path: "/tmp/rollout.jsonl",
				stop_hook_active: false,
			}),
		);

		writeFakeAgentMemory(
			binDir,
			'fs = require("node:fs"); fs.readFileSync(0); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "capture" } }));',
		);
		const blocked = Bun.spawnSync(["node", scriptPath], { stdin: input, stdout: "pipe", stderr: "pipe", env });
		expect(blocked.exitCode).toBe(0);
		const output = JSON.parse(blocked.stdout.toString());
		expect(output.decision).toBe("block");
		expect(typeof output.reason).toBe("string");
		expect(output.reason.length).toBeGreaterThan(0);
		expect(output.hookSpecificOutput).toBeUndefined();

		writeFakeAgentMemory(binDir, 'require("node:fs").readFileSync(0);');
		const quiet = Bun.spawnSync(["node", scriptPath], { stdin: input, stdout: "pipe", stderr: "pipe", env });
		expect(quiet.exitCode).toBe(0);
		expect(quiet.stdout.toString()).toBe("");

		writeFakeAgentMemory(binDir, 'require("node:fs").readFileSync(0); process.exit(1);');
		const failed = Bun.spawnSync(["node", scriptPath], { stdin: input, stdout: "pipe", stderr: "pipe", env });
		expect(failed.exitCode).toBe(0);
		expect(failed.stdout.toString()).toBe("");
	});
});
