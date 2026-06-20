const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");

function hasQmd() {
	const result = spawnSync("qmd", ["status"], {
		stdio: "ignore",
		shell: process.platform === "win32",
	});
	return result.status === 0;
}

function memoryDir() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return path.join(home, ".agent-memory");
}

// Distinguish a development checkout of agentmemory from an end-user install.
// When agentmemory is installed as a dependency it lives under node_modules and
// ships without the `.githooks` directory (it's absent from the package.json
// "files" allowlist). We must never touch a consumer's repo or VCS config, so
// the dev-only hook setup below is gated on "are we actually in the source repo?".
function isDevCheckout() {
	if (packageRoot.split(path.sep).includes("node_modules")) return false;
	return fs.existsSync(path.join(packageRoot, ".githooks"));
}

// Point git at the repo's tracked hooks (lint + tests on commit). Scoped to the
// agentmemory working tree only — `cwd` + the dev-checkout gate ensure we only
// ever write to this repo's local git config, never a consumer's.
function configureGitHooks() {
	const insideRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: packageRoot,
		stdio: "ignore",
		shell: process.platform === "win32",
	});
	if (insideRepo.status !== 0) {
		return;
	}

	spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
		cwd: packageRoot,
		stdio: "ignore",
		shell: process.platform === "win32",
	});
}

if (isDevCheckout()) {
	configureGitHooks();
}

if (!hasQmd()) {
	const dir = memoryDir();
	console.log("\nagent-memory: qmd not found (required for `memory_search`).\n");
	console.log("Install qmd (requires Bun):");
	console.log("  bun install -g https://github.com/tobi/qmd");
	console.log("  # ensure ~/.bun/bin is in your PATH\n");
	console.log("Then set up the collection (one-time):");
	console.log(`  qmd collection add ${dir} --name agent-memory`);
	console.log("  qmd embed\n");
}
