import fs from "node:fs";

function read(path) {
	return fs.readFileSync(path, "utf8");
}

function write(path, content) {
	fs.writeFileSync(path, content, "utf8");
}

function replaceOnce(path, from, to) {
	const source = read(path);
	const index = source.indexOf(from);
	if (index < 0) throw new Error(`missing expected fragment in ${path}: ${from.slice(0, 120)}`);
	if (source.indexOf(from, index + from.length) >= 0) throw new Error(`ambiguous expected fragment in ${path}`);
	write(path, source.slice(0, index) + to + source.slice(index + from.length));
}

// 1) Host-specific Stop control protocol. Claude consumes additionalContext;
// current Codex consumes decision:block + non-empty reason.
replaceOnce(
	"src/cli.ts",
	"async function cmdStop(_flags: Record<string, string | boolean>): Promise<void> {\n\tconst TIMEOUT_MS = 3_000;\n\tconst controller = new AbortController();",
	"async function cmdStop(flags: Record<string, string | boolean>): Promise<void> {\n\tconst TIMEOUT_MS = 3_000;\n\tconst controller = new AbortController();\n\tconst agent = getFlag(flags, \"agent\");",
);

replaceOnce(
	"src/cli.ts",
	`\t\tif (shouldNagOnStop(sessionId, Date.now(), capture)) {\n\t\t\tprocess.stdout.write(\n\t\t\t\tJSON.stringify({\n\t\t\t\t\thookSpecificOutput: { hookEventName: \"Stop\", additionalContext: STOP_NAG_REASON },\n\t\t\t\t}),\n\t\t\t);\n\t\t}`,
	`\t\tif (shouldNagOnStop(sessionId, Date.now(), capture)) {\n\t\t\tconst response =\n\t\t\t\tagent === \"codex\"\n\t\t\t\t\t? { decision: \"block\", reason: STOP_NAG_REASON }\n\t\t\t\t\t: { hookSpecificOutput: { hookEventName: \"Stop\", additionalContext: STOP_NAG_REASON } };\n\t\t\tprocess.stdout.write(JSON.stringify(response));\n\t\t}`,
);

replaceOnce(
	"src/cli.ts",
	`\t\t// Stop (write-side nudge) is Claude Code only and mode-independent.\n\t\tif (target.key === \"claude\") {\n\t\t\tif (!isStopHookInstalled(homeDir, target.key)) return false;\n\t\t}`,
	`\t\t// Stop capture checks are mode-independent for hosts with a verified Stop protocol.\n\t\tif (target.key === \"claude\" || target.key === \"codex\") {\n\t\t\tif (!isStopHookInstalled(homeDir, target.key)) return false;\n\t\t}`,
);

// 2) Upgrade the Codex evaluation from prompt-only to full immediate capture.
const evalPath = "eval/capture-reliability.ts";
let evaluation = read(evalPath);
const codexStart = evaluation.indexOf("function evaluateCodexPromptMechanism()");
const codexEnd = evaluation.indexOf("\nexport function runCaptureReliabilityEvaluation", codexStart);
if (codexStart < 0 || codexEnd < 0) throw new Error("could not locate Codex evaluation function");
const codexFunction = `function evaluateCodexMechanism(): Pick<\n\tCaptureHarnessResult,\n\t\"mechanizedExplicitRequest\" | \"mechanizedCompletedWork\" | \"mechanizedWriteClearsSignal\" | \"notes\"\n> {\n\tconst paths: string[] = [];\n\tconst sessionId = \"capture-eval\";\n\tconst meta = {\n\t\ttimestamp: \"2026-09-08T22:00:00Z\",\n\t\ttype: \"session_meta\",\n\t\tpayload: { session_id: sessionId, id: sessionId, cwd: \"/repo\", source: \"cli\" },\n\t};\n\tconst call = (type: \"function_call\" | \"custom_tool_call\", name: string, callId: string, args: unknown) => ({\n\t\ttimestamp: \"2026-09-08T22:00:02Z\",\n\t\ttype: \"response_item\",\n\t\tpayload: { type, name, call_id: callId, arguments: typeof args === \"string\" ? args : JSON.stringify(args) },\n\t});\n\tconst output = (type: \"function_call_output\" | \"custom_tool_call_output\", callId: string, value: unknown) => ({\n\t\ttimestamp: \"2026-09-08T22:00:03Z\",\n\t\ttype: \"response_item\",\n\t\tpayload: { type, call_id: callId, output: value },\n\t});\n\ttry {\n\t\tconst explicit = writeTranscript([\n\t\t\tmeta,\n\t\t\t{\n\t\t\t\ttimestamp: \"2026-09-08T22:00:01Z\",\n\t\t\t\tordinal: 1,\n\t\t\t\ttype: \"event_msg\",\n\t\t\t\tpayload: { type: \"user_message\", message: \"Remember this: staging uses PostgreSQL.\", kind: \"plain\" },\n\t\t\t},\n\t\t]);\n\t\tpaths.push(explicit);\n\t\tconst completed = writeTranscript([\n\t\t\tmeta,\n\t\t\tcall(\"custom_tool_call\", \"apply_patch\", \"patch-1\", \"*** Begin Patch\\n*** End Patch\"),\n\t\t\toutput(\"custom_tool_call_output\", \"patch-1\", { content: \"Done!\", success: true }),\n\t\t]);\n\t\tpaths.push(completed);\n\t\tconst cleared = writeTranscript([\n\t\t\tmeta,\n\t\t\tcall(\"custom_tool_call\", \"apply_patch\", \"patch-1\", \"*** Begin Patch\\n*** End Patch\"),\n\t\t\toutput(\"custom_tool_call_output\", \"patch-1\", { content: \"Done!\", success: true }),\n\t\t\tcall(\"function_call\", \"exec_command\", \"write-1\", {\n\t\t\t\tcmd: 'agent-memory write --content \"staging uses PostgreSQL\"',\n\t\t\t}),\n\t\t\toutput(\"function_call_output\", \"write-1\", {\n\t\t\t\tcontent:\n\t\t\t\t\t\"Chunk ID: abc\\nProcess exited with code 0\\nFinal output:\\nAppended to daily log: /memory/daily/2026-09-08.md\",\n\t\t\t\tsuccess: true,\n\t\t\t}),\n\t\t]);\n\t\tpaths.push(cleared);\n\n\t\tconst explicitContext = coreCaptureContextForQuery(\"Remember this: staging uses PostgreSQL.\");\n\t\tconst negativeContext = coreCaptureContextForQuery(\"Do not remember this: staging uses PostgreSQL.\");\n\t\tconst explicitCheck = checkCaptureTranscript(explicit, sessionId);\n\t\tconst completedCheck = checkCaptureTranscript(completed, sessionId);\n\t\tconst clearedCheck = checkCaptureTranscript(cleared, sessionId);\n\t\treturn {\n\t\t\tmechanizedExplicitRequest:\n\t\t\t\texplicitContext.some(\n\t\t\t\t\t(section) =>\n\t\t\t\t\t\tsection.id === \"core.capture.explicit-memory-request\" &&\n\t\t\t\t\t\tsection.content.includes(\"Save the durable fact in this turn\"),\n\t\t\t\t) &&\n\t\t\t\tnegativeContext.length === 0 &&\n\t\t\t\tBoolean(explicitCheck?.pendingSignal),\n\t\t\tmechanizedCompletedWork: Boolean(completedCheck?.pendingSignal),\n\t\t\tmechanizedWriteClearsSignal: clearedCheck !== null && clearedCheck.pendingSignal === undefined,\n\t\t\tnotes: [\n\t\t\t\t\"Codex UserPromptSubmit deterministically surfaces explicit memory requests.\",\n\t\t\t\t\"Codex Stop parses persisted rollout JSONL, detects successful apply_patch work, and retries uncaptured work with the host-native block/reason continuation protocol.\",\n\t\t\t],\n\t\t};\n\t} finally {\n\t\tfor (const transcript of paths) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });\n\t}\n}\n`;
evaluation = evaluation.slice(0, codexStart) + codexFunction + evaluation.slice(codexEnd);
evaluation = evaluation.replace("const codexMechanism = evaluateCodexPromptMechanism();", "const codexMechanism = evaluateCodexMechanism();");
evaluation = evaluation.replace('enforcement: "partially-mechanized",', 'enforcement: "mechanized",');
evaluation = evaluation.replace("mechanizedCompletedWork: null,\n\t\t\t\tmechanizedWriteClearsSignal: null,", "mechanizedCompletedWork: codexMechanism.mechanizedCompletedWork,\n\t\t\t\tmechanizedWriteClearsSignal: codexMechanism.mechanizedWriteClearsSignal,");
evaluation = evaluation.replace(
	"result.mechanizedExplicitRequest === true && result.mechanizedCompletedWork === true",
	"result.mechanizedExplicitRequest === true &&\n\t\t\tresult.mechanizedCompletedWork === true &&\n\t\t\tresult.mechanizedWriteClearsSignal === true",
);
evaluation = evaluation.replace("mechanizedImmediateCoverage === 0.25", "mechanizedImmediateCoverage === 0.5");
evaluation = evaluation.replace(
	"claudeMechanism.mechanizedWriteClearsSignal === true &&\n\t\tcodexMechanism.mechanizedExplicitRequest === true &&",
	"claudeMechanism.mechanizedWriteClearsSignal === true &&\n\t\tcodexMechanism.mechanizedExplicitRequest === true &&\n\t\tcodexMechanism.mechanizedWriteClearsSignal === true &&",
);
write(evalPath, evaluation);

// 3) Update deterministic evaluator expectations.
replaceOnce(
	"test/eval.test.ts",
	'test("measures partial Codex mechanization without overstating completed-work coverage", () => {',
	'test("measures fully mechanized Codex immediate capture coverage", () => {',
);
replaceOnce("test/eval.test.ts", "expect(report.metrics.mechanizedImmediateCoverage).toBe(0.25);", "expect(report.metrics.mechanizedImmediateCoverage).toBe(0.5);");
replaceOnce("test/eval.test.ts", 'expect(codex?.enforcement).toBe("partially-mechanized");', 'expect(codex?.enforcement).toBe("mechanized");');
replaceOnce("test/eval.test.ts", "expect(codex?.mechanizedCompletedWork).toBeNull();", "expect(codex?.mechanizedCompletedWork).toBe(true);");
replaceOnce("test/eval.test.ts", "expect(codex?.mechanizedWriteClearsSignal).toBeNull();", "expect(codex?.mechanizedWriteClearsSignal).toBe(true);");

// 4) Add a host-bound integration test: installer + real CLI subprocess response.
write(
	"test/codex-stop-hook.test.ts",
	`import { afterEach, describe, expect, test } from \"bun:test\";\nimport * as fs from \"node:fs\";\nimport * as os from \"node:os\";\nimport * as path from \"node:path\";\n\nimport { _setHookHomeDirForTest, installHooks, isStopHookInstalled, isUserPromptSubmitInstalled, uninstallHooks } from \"../src/hooks.js\";\n\nconst SESSION = \"11111111-2222-3333-4444-555555555555\";\nconst CLI = path.join(import.meta.dir, \"..\", \"src\", \"cli.ts\");\nconst homes: string[] = [];\n\nfunction tempHome(): string {\n\tconst home = fs.mkdtempSync(path.join(os.tmpdir(), \"agent-memory-codex-stop-\"));\n\thomes.push(home);\n\tfs.mkdirSync(path.join(home, \".codex\"), { recursive: true });\n\tfs.writeFileSync(path.join(home, \".codex\", \"config.toml\"), \"\");\n\treturn home;\n}\n\nfunction rollout(home: string, items: unknown[]): string {\n\tconst file = path.join(home, \"rollout.jsonl\");\n\tfs.writeFileSync(file, \\`\${items.map((item) => JSON.stringify(item)).join(\"\\n\")}\\n\\`);\n\treturn file;\n}\n\nfunction meta(): unknown {\n\treturn { timestamp: \"2026-09-08T22:00:00Z\", type: \"session_meta\", payload: { session_id: SESSION, id: SESSION, cwd: \"/repo\", source: \"cli\" } };\n}\n\nfunction patchExchange(): unknown[] {\n\treturn [\n\t\t{ timestamp: \"2026-09-08T22:00:02Z\", type: \"response_item\", payload: { type: \"custom_tool_call\", name: \"apply_patch\", call_id: \"patch-1\", arguments: \"*** Begin Patch\\n*** End Patch\" } },\n\t\t{ timestamp: \"2026-09-08T22:00:03Z\", type: \"response_item\", payload: { type: \"custom_tool_call_output\", call_id: \"patch-1\", output: { content: \"Done!\", success: true } } },\n\t];\n}\n\nfunction verifiedWriteExchange(): unknown[] {\n\treturn [\n\t\t{ timestamp: \"2026-09-08T22:00:04Z\", type: \"response_item\", payload: { type: \"function_call\", name: \"exec_command\", call_id: \"write-1\", arguments: JSON.stringify({ cmd: 'agent-memory write --content \"staging uses PostgreSQL\"' }) } },\n\t\t{ timestamp: \"2026-09-08T22:00:05Z\", type: \"response_item\", payload: { type: \"function_call_output\", call_id: \"write-1\", output: { content: \"Chunk ID: abc\\nProcess exited with code 0\\nFinal output:\\nAppended to daily log: /memory/daily/2026-09-08.md\", success: true } } },\n\t];\n}\n\nfunction runStop(home: string, transcript: string, stopHookActive = false) {\n\treturn Bun.spawnSync(\n\t\t[\"bun\", \"run\", CLI, \"hook\", \"stop\", \"--agent\", \"codex\", \"--dir\", path.join(home, \"memory\")],\n\t\t{\n\t\t\tstdin: Buffer.from(JSON.stringify({ session_id: SESSION, transcript_path: transcript, stop_hook_active: stopHookActive })),\n\t\t\tstdout: \"pipe\",\n\t\t\tstderr: \"pipe\",\n\t\t},\n\t);\n}\n\nafterEach(() => {\n\t_setHookHomeDirForTest(null);\n\tfor (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });\n});\n\ndescribe(\"Codex Stop capture wiring\", () => {\n\ttest(\"installer registers Stop in both per-turn and stable modes\", () => {\n\t\tconst home = tempHome();\n\t\t_setHookHomeDirForTest(home);\n\t\texpect(installHooks(new Set([\"codex\"]), \"per-turn\").results[0]?.installed).toBe(true);\n\t\tlet config = fs.readFileSync(path.join(home, \".codex\", \"config.toml\"), \"utf8\");\n\t\texpect(config).toContain(\"[[hooks.Stop]]\");\n\t\texpect(config).toContain('command = \"agent-memory hook stop --agent codex\"');\n\t\texpect(isStopHookInstalled(home, \"codex\")).toBe(true);\n\t\texpect(isUserPromptSubmitInstalled(home, \"codex\")).toBe(true);\n\n\t\texpect(installHooks(new Set([\"codex\"]), \"stable\").results[0]?.reason).toBe(\"updated\");\n\t\tconfig = fs.readFileSync(path.join(home, \".codex\", \"config.toml\"), \"utf8\");\n\t\texpect(config).toContain(\"[[hooks.Stop]]\");\n\t\texpect(isStopHookInstalled(home, \"codex\")).toBe(true);\n\t\texpect(isUserPromptSubmitInstalled(home, \"codex\")).toBe(false);\n\n\t\texpect(uninstallHooks(new Set([\"codex\"])).results[0]?.installed).toBe(true);\n\t\texpect(isStopHookInstalled(home, \"codex\")).toBe(false);\n\t});\n\n\ttest(\"pending Codex work returns the native block/reason continuation and respects re-entry\", () => {\n\t\tconst home = tempHome();\n\t\tconst transcript = rollout(home, [meta(), ...patchExchange()]);\n\t\tconst first = runStop(home, transcript);\n\t\texpect(first.exitCode).toBe(0);\n\t\texpect(JSON.parse(first.stdout.toString())).toEqual({\n\t\t\tdecision: \"block\",\n\t\t\treason: expect.stringContaining(\"capture it now\"),\n\t\t});\n\t\texpect(runStop(home, transcript).stdout.toString()).toBe(\"\");\n\t\texpect(runStop(home, transcript, true).stdout.toString()).toBe(\"\");\n\t});\n\n\ttest(\"a verified AgentMemory write clears the Codex pending signal\", () => {\n\t\tconst home = tempHome();\n\t\tconst transcript = rollout(home, [meta(), ...patchExchange(), ...verifiedWriteExchange()]);\n\t\tconst result = runStop(home, transcript);\n\t\texpect(result.exitCode).toBe(0);\n\t\texpect(result.stdout.toString()).toBe(\"\");\n\t});\n});\n`,
);

// Ensure CI executes the host-bound integration test.
replaceOnce(
	"package.json",
	'"test:eval": "bun test test/eval.test.ts test/codex-capture.test.ts",',
	'"test:eval": "bun test test/eval.test.ts test/codex-capture.test.ts test/codex-stop-hook.test.ts",',
);

// 5) Update docs and release notes to match what is actually wired.
write(
	"docs/capture-reliability-eval.md",
	`# Cross-harness capture reliability evaluation\n\nAgentMemory can only recall a durable fact after some harness actually captures it. Retrieval quality therefore cannot stand in for capture reliability.\n\n\`npm run eval:capture\` reports the current capture contract across Claude Code, Codex, Cursor, Qoder, and Pi without treating unlike integrations as equivalent.\n\n## Enforcement classes\n\n- **mechanized** — AgentMemory itself observes the evaluated capture opportunities and can deterministically verify the relevant path. Claude Code and Codex are currently in this class.\n- **partially-mechanized** — at least one capture opportunity is deterministically surfaced while another required immediate-capture path remains unproven. No current locally measured harness is in this class, but the classification remains explicit for future integrations.\n- **instruction-guided** — the installed skill tells the model to capture explicit memory requests and verified outcomes, but this repository cannot deterministically prove that a model followed the instruction on a real turn. Cursor and Qoder are currently in this class.\n- **delegated** — capture behavior is owned by another independently versioned package. Pi is delegated to \`pi-memory\`, so this repository does not count it in its measured denominator.\n\n## Metrics\n\n\`instructionCoverage\` is the fraction of locally measured harnesses whose shipped skill contains the required capture discipline: explicit memory requests are saved in-turn, write success is verified, and duplicate/routine notes are avoided.\n\n\`mechanizedExplicitRequestCoverage\` asks for how many locally measured harnesses AgentMemory can deterministically surface an explicit user request to remember something. This is 50% (\`claude\` + \`codex\`).\n\n\`mechanizedImmediateCoverage\` is stricter. A harness only counts when AgentMemory can deterministically observe an explicit memory request, completed work, and a successful AgentMemory write clearing the pending signal.\n\nThe expected baseline after Codex Stop activation is:\n\n- measured local harnesses: 4 (\`claude\`, \`codex\`, \`cursor\`, \`qoder\`)\n- instruction coverage: 100%\n- mechanized explicit-request coverage: 50% (\`claude\`, \`codex\`)\n- mechanized immediate coverage: 50% (\`claude\`, \`codex\`)\n- delegated harnesses: 1 (\`pi\` via \`pi-memory\`)\n\nCodex reaches the stricter class only because the repository now proves the full chain: \`UserPromptSubmit\` surfaces explicit requests, the Stop hook parses the persisted Codex rollout, successful \`apply_patch\` work creates a pending capture signal, a verified AgentMemory write clears it, and pending work returns Codex's native \`decision: block\` plus non-empty \`reason\` continuation response.\n\n## What this does not claim\n\nThis evaluation does not claim that every eligible fact is semantically worth saving, that a model always obeys an installed skill, or that a captured note is useful later. Those require separate behavioral/longitudinal evaluations. It also does not import \`pi-memory\` internals into AgentMemory; Pi should have its own equivalent capture evaluation in that repository and can later be joined through a versioned cross-repo compatibility lane.\n`,
);

write(
	"docs/codex-rollout-capture.md",
	`# Codex rollout capture contract\n\nAgentMemory's Claude capture check cannot be reused blindly for Codex because the persisted transcript schemas and Stop control protocols differ.\n\nCodex Stop hooks expose \`transcript_path\`, which points at the persisted rollout JSONL. The capture parser recognizes only documented/persisted high-confidence records:\n\n- \`session_meta.payload.session_id\` / \`id\` binds the file to the hook session.\n- \`event_msg.payload.type = user_message\` supplies explicit user memory requests.\n- \`response_item.payload.type = custom_tool_call\` / \`custom_tool_call_output\` represents tools such as \`apply_patch\`.\n- \`response_item.payload.type = function_call\` / \`function_call_output\` represents function tools such as \`exec_command\`.\n\nA successful \`apply_patch\` output is treated as completed work. A failed patch (\`success: false\`) is not. A later verified \`agent-memory write\` or \`agent-memory save\` command clears the pending capture signal.\n\nThe parser reads only a bounded transcript tail and returns \`null\` for unusable or session-mismatched files. Callers persist only the hashed signal identifier, never transcript content.\n\nThe Codex installer registers a mode-independent \`[[hooks.Stop]]\` command in the managed \`config.toml\` block. When a pending signal should be retried, \`agent-memory hook stop --agent codex\` emits Codex's supported continuation shape, \`{\"decision\":\"block\",\"reason\":\"...\"}\`. A re-entered Stop with \`stop_hook_active: true\` remains fail-open and emits nothing, preventing a self-sustaining hook loop.\n\nClaude continues to use its own \`hookSpecificOutput.additionalContext\` response. Keeping the output protocol host-specific prevents a compatibility claim from leaking across harnesses.\n`,
);

replaceOnce(
	"CHANGELOG.md",
	"## [Unreleased]\n",
	"## [Unreleased]\n\n### Added\n\n- Added fully mechanized Codex immediate capture: managed Stop-hook installation, bounded native rollout parsing, host-native `decision: block` continuation for uncaptured completed work, verified-write signal clearing, and a CI-gated cross-harness coverage increase from 25% to 50%.\n",
);

console.log("Codex Stop wiring patch applied successfully.");
