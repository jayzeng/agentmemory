from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected text in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    p = Path(path)
    text = p.read_text()
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"expected one regex match in {path}, got {count}: {pattern[:120]!r}")
    p.write_text(next_text)


# Shared Claude/Qoder JSONL parser: Qoder documents the same user/assistant
# content-block shape, with native edit and terminal tool names.
replace_once(
    "src/capture-check.ts",
    'const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);',
    'const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "create_file", "search_replace", "edit_file"]);',
)
replace_once(
    "src/capture-check.ts",
    'if (name !== "Bash") return false;',
    'if (!["Bash", "run_in_terminal"].includes(name)) return false;',
)
replace_once(
    "src/capture-check.ts",
    " * Supports both Claude Code JSONL and Codex persisted rollout JSONL.",
    " * Supports Claude Code / Qoder content-block JSONL and Codex persisted rollout JSONL.",
)

# Hook installer/health: Qoder now gets a mode-independent Stop hook.
replace_once(
    "src/hooks.ts",
    'function stopHookCommand(agent: "claude" | "codex"): string {',
    'function stopHookCommand(agent: "claude" | "codex" | "qoder"): string {',
)

marker = '/**\n * Read-only check whether the SessionStart hook for `key` is already present in\n'
qoder_helper = '''function hasQoderHookGroup(homeDir: string, eventKey: string, command: string): boolean {
\tconst settingsPath = path.join(homeDir, ".qoder", "settings.json");
\tif (!fs.existsSync(settingsPath)) return false;
\tconst settings = readJsonConfig(settingsPath);
\tconst hooks = (settings.hooks as Record<string, unknown>) ?? {};
\tconst groups = Array.isArray(hooks[eventKey]) ? (hooks[eventKey] as unknown[]) : [];
\tfor (const group of groups) {
\t\tif (!group || typeof group !== "object") continue;
\t\tconst list = Array.isArray((group as Record<string, unknown>).hooks)
\t\t\t? ((group as Record<string, unknown>).hooks as unknown[])
\t\t\t: [];
\t\tfor (const hook of list) {
\t\t\tif (hook && typeof hook === "object" && (hook as Record<string, unknown>).command === command) return true;
\t\t}
\t}
\treturn false;
}

'''
replace_once("src/hooks.ts", marker, qoder_helper + marker)

replace_once(
    "src/hooks.ts",
    '\t} catch {\n\t\treturn false;\n\t}\n\treturn false;\n}\n\n/**\n * Read-only check whether the per-turn UserPromptSubmit hook is present.',
    '\t\tif (key === "qoder") {\n\t\t\treturn (\n\t\t\t\thasQoderHookGroup(homeDir, "SessionStart", "agent-memory context") &&\n\t\t\t\tisStopHookInstalled(homeDir, "qoder")\n\t\t\t);\n\t\t}\n\t} catch {\n\t\treturn false;\n\t}\n\treturn false;\n}\n\n/**\n * Read-only check whether the per-turn UserPromptSubmit hook is present.',
)
replace_once(
    "src/hooks.ts",
    '\t\tif (key === "codex") {\n\t\t\tconst configPath = path.join(homeDir, ".codex", "config.toml");\n\t\t\tif (!fs.existsSync(configPath)) return false;\n\t\t\tconst existing = fs.readFileSync(configPath, "utf-8");\n\t\t\tif (!existing.includes(HOOK_MARKER_BEGIN)) return false;\n\t\t\treturn existing.includes(`command = "${stopHookCommand("codex")}"`);\n\t\t}\n',
    '\t\tif (key === "codex") {\n\t\t\tconst configPath = path.join(homeDir, ".codex", "config.toml");\n\t\t\tif (!fs.existsSync(configPath)) return false;\n\t\t\tconst existing = fs.readFileSync(configPath, "utf-8");\n\t\t\tif (!existing.includes(HOOK_MARKER_BEGIN)) return false;\n\t\t\treturn existing.includes(`command = "${stopHookCommand("codex")}"`);\n\t\t}\n\t\tif (key === "qoder") return hasQoderHookGroup(homeDir, "Stop", stopHookCommand("qoder"));\n',
)

regex_once(
    "src/hooks.ts",
    r'function installQoderHook\(homeDir: string\): HookInstallResult \{.*?\n\}\n\nfunction uninstallQoderHook',
    '''function installQoderHook(homeDir: string): HookInstallResult {
\tconst settingsPath = path.join(homeDir, ".qoder", "settings.json");
\tconst backup = backupOnce(settingsPath);
\tconst settings = readJsonConfig(settingsPath);
\tconst hooks = (settings.hooks as Record<string, unknown>) ?? {};
\tconst session = upsertClaudeHookGroup(hooks, "SessionStart", "agent-memory context");
\tconst stop = upsertClaudeHookGroup(hooks, "Stop", stopHookCommand("qoder"));

\tif (!session.changed && !stop.changed) {
\t\treturn { key: "qoder", label: "Qoder", installed: false, path: settingsPath, reason: "already installed" };
\t}
\tsettings.hooks = hooks;
\twriteJson(settingsPath, settings);
\tconst reason = session.hadManaged || stop.hadManaged ? "updated" : undefined;
\treturn { key: "qoder", label: "Qoder", installed: true, path: settingsPath, backup, reason };
}

function uninstallQoderHook''',
)
regex_once(
    "src/hooks.ts",
    r'function uninstallQoderHook\(homeDir: string\): HookInstallResult \{.*?\n\}\n\nexport function installHooks',
    '''function uninstallQoderHook(homeDir: string): HookInstallResult {
\tconst settingsPath = path.join(homeDir, ".qoder", "settings.json");
\tif (!fs.existsSync(settingsPath)) {
\t\treturn { key: "qoder", label: "Qoder", installed: false, reason: "not installed" };
\t}
\tconst settings = readJsonConfig(settingsPath);
\tconst hooks = (settings.hooks as Record<string, unknown>) ?? {};
\tconst sessionRemoved = removeClaudeHookGroup(hooks, "SessionStart", "agent-memory context");
\tconst stopRemoved = removeClaudeHookGroup(hooks, "Stop", stopHookCommand("qoder"));
\tif (!sessionRemoved && !stopRemoved) {
\t\treturn { key: "qoder", label: "Qoder", installed: false, reason: "not installed" };
\t}
\tif (Object.keys(hooks).length === 0) delete (settings as Record<string, unknown>).hooks;
\telse settings.hooks = hooks;
\twriteJson(settingsPath, settings);
\treturn { key: "qoder", label: "Qoder", installed: true, path: settingsPath };
}

export function installHooks''',
)

# Qoder's documented Stop control contract is exit 2 + stderr feedback.
replace_once(
    "src/cli.ts",
    ' * Hosts without a usable transcript retain the periodic reminder. Claude emits\n * `hookSpecificOutput.additionalContext`; Codex emits its native `decision: "block"`\n * plus a non-empty `reason`. Both honor `stop_hook_active` re-entry protection.\n * Always allows the stop (empty stdout) on missing session_id, re-entry, or any\n * internal error.',
    ' * Hosts without a usable transcript retain the periodic reminder. Claude emits\n * `hookSpecificOutput.additionalContext`; Codex emits its native `decision: "block"`\n * plus a non-empty `reason`; Qoder blocks with exit code 2 and writes the reason to\n * stderr. All honor `stop_hook_active` re-entry protection and fail open on errors.',
)
replace_once(
    "src/cli.ts",
    '''\t\tif (shouldNagOnStop(sessionId, Date.now(), capture)) {
\t\t\tconst response =
\t\t\t\tagent === "codex"
\t\t\t\t\t? { decision: "block", reason: STOP_NAG_REASON }
\t\t\t\t\t: { hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_NAG_REASON } };
\t\t\tprocess.stdout.write(JSON.stringify(response));
\t\t}
''',
    '''\t\tif (shouldNagOnStop(sessionId, Date.now(), capture)) {
\t\t\tif (agent === "qoder") {
\t\t\t\tprocess.stderr.write(`${STOP_NAG_REASON}\\n`);
\t\t\t\tprocess.exitCode = 2;
\t\t\t\treturn;
\t\t\t}
\t\t\tconst response =
\t\t\t\tagent === "codex"
\t\t\t\t\t? { decision: "block", reason: STOP_NAG_REASON }
\t\t\t\t\t: { hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_NAG_REASON } };
\t\t\tprocess.stdout.write(JSON.stringify(response));
\t\t}
''',
)
replace_once(
    "src/cli.ts",
    'detail: "no supported agents detected (Claude Code, Codex, Cursor, opencode, pi)",',
    'detail: "no supported agents detected (Claude Code, Codex, Cursor, Qoder, opencode, pi)",',
)
replace_once(
    "src/cli.ts",
    '\t\t\t} else if (!supportsPerTurn) {\n\t\t\t\tdetail = "SessionStart hook active";',
    '\t\t\t} else if (target.key === "qoder") {\n\t\t\t\tdetail = "SessionStart + Stop capture hooks active";\n\t\t\t} else if (!supportsPerTurn) {\n\t\t\t\tdetail = "SessionStart hook active";',
)

# Cross-harness eval: Qoder must pass explicit request, completed edit, and write-clear fixtures.
insert_before = 'export function runCaptureReliabilityEvaluation(): CaptureReliabilityReport {'
qoder_eval = '''const QODER_SESSION = "qoder-capture-eval";

function qoderMeta(): unknown {
\treturn { type: "session_meta", sessionId: QODER_SESSION, uuid: "meta", data: { meta_type: "session_info" } };
}

function qoderUser(content: unknown, uuid: string): unknown {
\treturn { type: "user", sessionId: QODER_SESSION, uuid, message: { role: "user", content } };
}

function qoderTool(name: string, id: string, input: unknown, content: string, isError = false): unknown[] {
\treturn [
\t\t{
\t\t\ttype: "assistant",
\t\t\tsessionId: QODER_SESSION,
\t\t\tuuid: `${id}-call`,
\t\t\tmessage: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
\t\t},
\t\tqoderUser([{ type: "tool_result", tool_use_id: id, content, is_error: isError }], `${id}-result`),
\t];
}

function evaluateQoderMechanism(): Pick<
\tCaptureHarnessResult,
\t"mechanizedExplicitRequest" | "mechanizedCompletedWork" | "mechanizedWriteClearsSignal" | "notes"
> {
\tconst paths: string[] = [];
\ttry {
\t\tconst explicit = writeTranscript([qoderMeta(), qoderUser("Remember this: staging uses PostgreSQL.", "request")]);
\t\tpaths.push(explicit);
\t\tconst completed = writeTranscript([
\t\t\tqoderMeta(),
\t\t\t...qoderTool("search_replace", "edit-1", { file_path: "/repo/auth.ts" }, "Updated", false),
\t\t]);
\t\tpaths.push(completed);
\t\tconst cleared = writeTranscript([
\t\t\tqoderMeta(),
\t\t\t...qoderTool("create_file", "edit-1", { file_path: "/repo/auth.ts" }, "Created", false),
\t\t\t...qoderTool(
\t\t\t\t"run_in_terminal",
\t\t\t\t"write-1",
\t\t\t\t{ command: 'agent-memory write --content "staging uses PostgreSQL"' },
\t\t\t\t"Appended to daily log: /memory/daily/2026-09-08.md",
\t\t\t\tfalse,
\t\t\t),
\t\t]);
\t\tpaths.push(cleared);
\t\tconst explicitCheck = checkCaptureTranscript(explicit, QODER_SESSION);
\t\tconst completedCheck = checkCaptureTranscript(completed, QODER_SESSION);
\t\tconst clearedCheck = checkCaptureTranscript(cleared, QODER_SESSION);
\t\treturn {
\t\t\tmechanizedExplicitRequest: Boolean(explicitCheck?.pendingSignal),
\t\t\tmechanizedCompletedWork: Boolean(completedCheck?.pendingSignal),
\t\t\tmechanizedWriteClearsSignal: clearedCheck !== null && clearedCheck.pendingSignal === undefined,
\t\t\tnotes: [
\t\t\t\t"Qoder Stop reads its documented persisted transcript JSONL and blocks with exit 2 when capture is pending.",
\t\t\t\t"Qoder native create_file/search_replace edits and run_in_terminal AgentMemory writes are verified deterministically.",
\t\t\t],
\t\t};
\t} finally {
\t\tfor (const transcript of paths) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
\t}
}

'''
replace_once("eval/capture-reliability.ts", insert_before, qoder_eval + insert_before)
replace_once(
    "eval/capture-reliability.ts",
    '\tconst codexMechanism = evaluateCodexMechanism();\n',
    '\tconst codexMechanism = evaluateCodexMechanism();\n\tconst qoderMechanism = evaluateQoderMechanism();\n',
)
replace_once(
    "eval/capture-reliability.ts",
    '''\t\tif (harness === "codex") {
\t\t\treturn {
\t\t\t\tharness,
\t\t\t\tenforcement: "mechanized",
\t\t\t\tmeasured: true,
\t\t\t\tinstructionContract: skillHasCaptureContract(skillPath),
\t\t\t\tmechanizedExplicitRequest: codexMechanism.mechanizedExplicitRequest,
\t\t\t\tmechanizedCompletedWork: codexMechanism.mechanizedCompletedWork,
\t\t\t\tmechanizedWriteClearsSignal: codexMechanism.mechanizedWriteClearsSignal,
\t\t\t\tnotes: codexMechanism.notes,
\t\t\t};
\t\t}
''',
    '''\t\tif (harness === "codex") {
\t\t\treturn {
\t\t\t\tharness,
\t\t\t\tenforcement: "mechanized",
\t\t\t\tmeasured: true,
\t\t\t\tinstructionContract: skillHasCaptureContract(skillPath),
\t\t\t\tmechanizedExplicitRequest: codexMechanism.mechanizedExplicitRequest,
\t\t\t\tmechanizedCompletedWork: codexMechanism.mechanizedCompletedWork,
\t\t\t\tmechanizedWriteClearsSignal: codexMechanism.mechanizedWriteClearsSignal,
\t\t\t\tnotes: codexMechanism.notes,
\t\t\t};
\t\t}
\t\tif (harness === "qoder") {
\t\t\treturn {
\t\t\t\tharness,
\t\t\t\tenforcement: "mechanized",
\t\t\t\tmeasured: true,
\t\t\t\tinstructionContract: skillHasCaptureContract(skillPath),
\t\t\t\tmechanizedExplicitRequest: qoderMechanism.mechanizedExplicitRequest,
\t\t\t\tmechanizedCompletedWork: qoderMechanism.mechanizedCompletedWork,
\t\t\t\tmechanizedWriteClearsSignal: qoderMechanism.mechanizedWriteClearsSignal,
\t\t\t\tnotes: qoderMechanism.notes,
\t\t\t};
\t\t}
''',
)
replace_once(
    "eval/capture-reliability.ts",
    '\t\tmechanizedExplicitRequestCoverage === 0.5 &&\n\t\tmechanizedImmediateCoverage === 0.5 &&',
    '\t\tmechanizedExplicitRequestCoverage === 0.75 &&\n\t\tmechanizedImmediateCoverage === 0.75 &&',
)
replace_once(
    "eval/capture-reliability.ts",
    '\t\tcodexMechanism.mechanizedWriteClearsSignal === true &&\n\t\tisExplicitMemoryRequest',
    '\t\tcodexMechanism.mechanizedWriteClearsSignal === true &&\n\t\tqoderMechanism.mechanizedExplicitRequest === true &&\n\t\tqoderMechanism.mechanizedCompletedWork === true &&\n\t\tqoderMechanism.mechanizedWriteClearsSignal === true &&\n\t\tisExplicitMemoryRequest',
)

# Eval assertions now require Qoder mechanization and leave Cursor as the sole local instruction-guided harness.
replace_once(
    "test/eval.test.ts",
    'test("measures Claude and Codex as fully mechanized without overstating delegated Pi coverage", () => {',
    'test("measures Claude, Codex, and Qoder as fully mechanized without overstating delegated Pi coverage", () => {',
)
replace_once("test/eval.test.ts", 'expect(report.metrics.mechanizedExplicitRequestCoverage).toBe(0.5);', 'expect(report.metrics.mechanizedExplicitRequestCoverage).toBe(0.75);')
replace_once("test/eval.test.ts", 'expect(report.metrics.mechanizedImmediateCoverage).toBe(0.5);', 'expect(report.metrics.mechanizedImmediateCoverage).toBe(0.75);')
replace_once(
    "test/eval.test.ts",
    '''\t\tfor (const harness of ["cursor", "qoder"]) {
\t\t\tconst result = report.harnesses.find((entry) => entry.harness === harness);
\t\t\texpect(result?.instructionContract).toBe(true);
\t\t\texpect(result?.enforcement).toBe("instruction-guided");
\t\t\texpect(result?.mechanizedExplicitRequest).toBeNull();
\t\t}
''',
    '''\t\tconst qoder = report.harnesses.find((result) => result.harness === "qoder");
\t\texpect(qoder?.instructionContract).toBe(true);
\t\texpect(qoder?.enforcement).toBe("mechanized");
\t\texpect(qoder?.mechanizedExplicitRequest).toBe(true);
\t\texpect(qoder?.mechanizedCompletedWork).toBe(true);
\t\texpect(qoder?.mechanizedWriteClearsSignal).toBe(true);

\t\tconst cursor = report.harnesses.find((entry) => entry.harness === "cursor");
\t\texpect(cursor?.instructionContract).toBe(true);
\t\texpect(cursor?.enforcement).toBe("instruction-guided");
\t\texpect(cursor?.mechanizedExplicitRequest).toBeNull();
''',
)

# Dedicated Qoder installer/runtime fixtures.
Path("test/qoder-stop-install.test.ts").write_text(r'''import { afterEach, describe, expect, test } from "bun:test";
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
		stdin: Buffer.from(JSON.stringify({ session_id: SESSION, transcript_path: transcriptPath, stop_hook_active: stopHookActive })),
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
			JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "agent-memory context", _agentMemory: true }] }] } }, null, 2),
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
		const transcript = writeTranscript(home, [meta(), ...tool("search_replace", "edit-1", { file_path: "/repo/a.ts" }, "Updated")]);
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
''')

replace_once(
    "package.json",
    '"test:cli": "bun test test/cli.test.ts test/codex-stop-install.test.ts --timeout 15000",',
    '"test:cli": "bun test test/cli.test.ts test/codex-stop-install.test.ts test/qoder-stop-install.test.ts --timeout 15000",',
)

# Documentation and release notes.
replace_once(
    "docs/capture-reliability-eval.md",
    "- **mechanized** — AgentMemory itself observes the evaluated capture opportunities and can deterministically verify the relevant path. Claude Code and Codex are in this class.",
    "- **mechanized** — AgentMemory itself observes the evaluated capture opportunities and can deterministically verify the relevant path. Claude Code, Codex, and Qoder are in this class.",
)
replace_once(
    "docs/capture-reliability-eval.md",
    '`mechanizedExplicitRequestCoverage` measures the narrower question: for how many locally measured harnesses can AgentMemory deterministically surface an explicit user request to remember something? This is 50% (`claude` + `codex`).',
    '`mechanizedExplicitRequestCoverage` measures the narrower question: for how many locally measured harnesses can AgentMemory deterministically surface an explicit user request to remember something? This is 75% (`claude` + `codex` + `qoder`).',
)
replace_once(
    "docs/capture-reliability-eval.md",
    '- mechanized explicit-request coverage: 50% (`claude`, `codex`)\n- mechanized immediate coverage: 50% (`claude`, `codex`)',
    '- mechanized explicit-request coverage: 75% (`claude`, `codex`, `qoder`)\n- mechanized immediate coverage: 75% (`claude`, `codex`, `qoder`)',
)
replace_once(
    "docs/capture-reliability-eval.md",
    "The stricter number moves only because CI now proves both Codex completed-work detection and verified-write clearing, and the installer tests prove the Codex Stop protocol is present and idempotent. Future host-specific mechanisms should raise the metric only with the same kind of executable evidence.",
    "The stricter number moves only when CI proves completed-work detection, verified-write clearing, and the installed host Stop control path. Qoder now meets that bar through its documented transcript schema and native exit-2/stderr continuation contract. Future host-specific mechanisms should raise the metric only with the same kind of executable evidence.",
)

Path("docs/qoder-stop-capture.md").write_text('''# Qoder Stop capture contract

Qoder publishes deterministic hooks and a persisted JSONL transcript for every event. AgentMemory uses those documented surfaces directly rather than relying on model compliance.

## Inputs

The managed user-level `~/.qoder/settings.json` block keeps the existing `SessionStart` context hook and adds a mode-independent `Stop` hook:

```text
agent-memory hook stop --agent qoder
```

Qoder provides `session_id`, `transcript_path`, and `stop_hook_active` to Stop. Its transcript uses `user` / `assistant` content blocks with `tool_use` and `tool_result` pairs. AgentMemory recognizes the documented native edit tools `create_file`, `search_replace`, and `edit_file`, plus compatible `Write` / `Edit` names. A failed tool result never creates a completed-work signal.

A verified `agent-memory write` / `save` executed through Qoder's `run_in_terminal` tool clears the pending signal only when the tool result is successful and contains a valid AgentMemory receipt.

## Stop control

Qoder's supported block protocol is process exit code `2` with the continuation reason on stderr. AgentMemory therefore emits no JSON adapter for Qoder: Core writes the capture guidance to stderr and sets exit code 2 only when a pending signal passes the cadence/state check. `stop_hook_active: true`, missing inputs, parser errors, and internal failures all fail open.

## Evidence basis

- Qoder hook events and Stop control: https://docs.qoder.com/cli/hooks
- Qoder IDE hook input/transcript schema and native tool names: https://docs.qoder.com/extensions/hooks

The cross-harness evaluator counts Qoder as mechanized only because CI exercises explicit requests, successful and failed native edits, the real Stop process contract, idempotent install/uninstall behavior, and verified-write clearing.
''')

replace_once(
    "CHANGELOG.md",
    '- Codex now gets a mode-independent managed `Stop` capture hook that invokes Core directly, parses native rollout JSONL for completed work, emits Codex\'s `decision: "block"` + `reason` continuation when capture is pending, and clears the signal after a verified AgentMemory write. Cross-harness fully mechanized immediate capture coverage rises from 25% to 50% (Claude + Codex) under the CI-gated evaluator.\n',
    '- Codex now gets a mode-independent managed `Stop` capture hook that invokes Core directly, parses native rollout JSONL for completed work, emits Codex\'s `decision: "block"` + `reason` continuation when capture is pending, and clears the signal after a verified AgentMemory write. Cross-harness fully mechanized immediate capture coverage rises from 25% to 50% (Claude + Codex) under the CI-gated evaluator.\n- Qoder now gets a managed mode-independent `Stop` capture hook using its documented JSONL transcript and native exit-2/stderr continuation contract. Native file edits and verified terminal memory writes are CI-gated, raising fully mechanized immediate capture coverage from 50% to 75% (Claude + Codex + Qoder).\n',
)
replace_once(
    "CLAUDE.md",
    "A persistent memory system for coding agents — Claude Code, OpenAI Codex, Cursor, opencode.",
    "A persistent memory system for coding agents — Claude Code, OpenAI Codex, Cursor, Qoder, opencode.",
)
replace_once(
    "CLAUDE.md",
    '- **`src/hooks.ts`**: Install/uninstall managed hooks into Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/config.toml`), Cursor (`.mdc` rule), and opencode. Claude Code and Codex both get mode-independent `Stop` capture checks backed by the shared Core transcript/state machine; Claude emits `hookSpecificOutput.additionalContext`, while Codex emits its native `decision: "block"` + `reason` response. Codex invokes Core directly with no adapter/runtime dependency.',
    '- **`src/hooks.ts`**: Install/uninstall managed hooks into Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/config.toml`), Cursor, Qoder (`~/.qoder/settings.json`), and opencode. Claude Code, Codex, and Qoder get mode-independent `Stop` capture checks backed by the shared Core transcript/state machine; Claude emits `hookSpecificOutput.additionalContext`, Codex emits `decision: "block"` + `reason`, and Qoder uses its native exit-2/stderr continuation contract.',
)

print("Qoder Stop capture slice applied")
