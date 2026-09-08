from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path}, found {count}: {old!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/cli.ts",
    '''\t\t\t// Stop backs the write side with a periodic memory-write nudge. Claude
\t\t\t// Code only for now, mode-independent — always wanted when supported.
\t\t\tconst wantsWriteHooks = target.key === "claude";''',
    '''\t\t\t// Claude exposes Stop health as a separate row-level check. Codex Stop
\t\t\t// is already required by isHookInstalled(codex), so do not double-count it here.
\t\t\tconst wantsWriteHooks = target.key === "claude";''',
)

replace_once(
    "CHANGELOG.md",
    "## [Unreleased]\n",
    '''## [Unreleased]

### Added

- Codex now gets a mode-independent managed `Stop` capture hook that invokes Core directly, parses native rollout JSONL for completed work, emits Codex's `decision: "block"` + `reason` continuation when capture is pending, and clears the signal after a verified AgentMemory write. Cross-harness fully mechanized immediate capture coverage rises from 25% to 50% (Claude + Codex) under the CI-gated evaluator.
''',
)

print("final Codex Stop consistency fixes applied")
