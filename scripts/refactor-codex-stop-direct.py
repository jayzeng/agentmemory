from pathlib import Path
import subprocess

BASE = "4338aef20e596a01d6fc0b115070fa0fe778bb17"


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path}, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


subprocess.run(["git", "checkout", BASE, "--", "src/hooks.ts"], check=True)

replace_once(
    "src/hooks.ts",
    '''function stopHookCommand(agent: "claude"): string {
\treturn `agent-memory hook stop --agent ${agent}`;
}''',
    '''function stopHookCommand(agent: "claude" | "codex"): string {
\treturn `agent-memory hook stop --agent ${agent}`;
}''',
)
replace_once(
    "src/hooks.ts",
    '''\t\t\tconst command = sessionStartHookCommand("codex");
\t\t\treturn existing.includes(`command = "${command}"`);''',
    '''\t\t\tconst command = sessionStartHookCommand("codex");
\t\t\treturn existing.includes(`command = "${command}"`) && isStopHookInstalled(homeDir, "codex");''',
)
replace_once(
    "src/hooks.ts",
    '''/**
 * Read-only check whether the periodic Stop-hook memory-write nudge is present.
 * Claude Code only — Codex/Cursor/opencode don't have a confirmed equivalent
 * block/reason protocol for this event yet.
 */
export function isStopHookInstalled(homeDir: string, key: HookAgentKey): boolean {
\ttry {
\t\tif (key === "claude") return hasClaudeHookGroup(homeDir, "Stop", stopHookCommand("claude"));
\t} catch {}
\treturn false;
}''',
    '''/** Read-only check whether the Stop-hook memory-write capture check is present. */
export function isStopHookInstalled(homeDir: string, key: HookAgentKey): boolean {
\ttry {
\t\tif (key === "claude") return hasClaudeHookGroup(homeDir, "Stop", stopHookCommand("claude"));
\t\tif (key === "codex") {
\t\t\tconst configPath = path.join(homeDir, ".codex", "config.toml");
\t\t\tif (!fs.existsSync(configPath)) return false;
\t\t\tconst existing = fs.readFileSync(configPath, "utf-8");
\t\t\tif (!existing.includes(HOOK_MARKER_BEGIN)) return false;
\t\t\treturn existing.includes(`command = "${stopHookCommand("codex")}"`);
\t\t}
\t} catch {}
\treturn false;
}''',
)
replace_once(
    "src/hooks.ts",
    '''\tconst sessionCommand = sessionStartHookCommand("codex");
\tconst promptCommand = userPromptSubmitHookCommand("codex");''',
    '''\tconst sessionCommand = sessionStartHookCommand("codex");
\tconst promptCommand = userPromptSubmitHookCommand("codex");
\tconst stopCommand = stopHookCommand("codex");''',
)
replace_once(
    "src/hooks.ts",
    '''\tlines.push(HOOK_MARKER_END);
\tconst block = lines.join("\\n");''',
    '''\tlines.push(
\t\t"",
\t\t"[[hooks.Stop]]",
\t\t"",
\t\t"[[hooks.Stop.hooks]]",
\t\t'type = "command"',
\t\t`command = "${stopCommand}"`,
\t\tHOOK_MARKER_END,
\t);
\tconst block = lines.join("\\n");''',
)

replace_once(
    "src/cli.ts",
    '''async function cmdStop(_flags: Record<string, string | boolean>): Promise<void> {
\tconst TIMEOUT_MS = 3_000;
\tconst controller = new AbortController();''',
    '''async function cmdStop(flags: Record<string, string | boolean>): Promise<void> {
\tconst TIMEOUT_MS = 3_000;
\tconst controller = new AbortController();
\tconst agent = getFlag(flags, "agent");''',
)
replace_once(
    "src/cli.ts",
    '''\t\tif (shouldNagOnStop(sessionId, Date.now(), capture)) {
\t\t\tprocess.stdout.write(
\t\t\t\tJSON.stringify({
\t\t\t\t\thookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_NAG_REASON },
\t\t\t\t}),
\t\t\t);
\t\t}''',
    '''\t\tif (shouldNagOnStop(sessionId, Date.now(), capture)) {
\t\t\tconst response =
\t\t\t\tagent === "codex"
\t\t\t\t\t? { decision: "block", reason: STOP_NAG_REASON }
\t\t\t\t\t: { hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_NAG_REASON } };
\t\t\tprocess.stdout.write(JSON.stringify(response));
\t\t}''',
)
replace_once(
    "src/cli.ts",
    ''' * Hosts without a usable transcript retain the periodic reminder. Uses `hookSpecificOutput.additionalContext` rather than
 * `decision: "block"` — functionally identical (both go through the same
 * `stop_hook_active` re-entry check and Claude Code's loop-protection cap),
 * but additionalContext renders as "Stop hook feedback" in the transcript
 * instead of the alarming-looking "Stop hook error". Always allows the stop
 * (empty stdout) on missing session_id, `stop_hook_active` (Claude Code's own
 * re-entrancy signal — never nag twice in a row), or any internal error.''',
    ''' * Hosts without a usable transcript retain the periodic reminder. Claude emits
 * `hookSpecificOutput.additionalContext`; Codex emits its native `decision: "block"`
 * plus a non-empty `reason`. Both honor `stop_hook_active` re-entry protection.
 * Always allows the stop (empty stdout) on missing session_id, re-entry, or any
 * internal error.''',
)

print("direct Codex Stop refactor applied")
