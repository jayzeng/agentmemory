#!/usr/bin/env node

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExternalCommandHost, runExternalCommand, shouldTryExternalCommand } from "./external-command.js";

async function runCoreCli(): Promise<void> {
	// The npm package keeps dist/cli.js as the public bin for compatibility. During
	// packaging the launcher is copied to that path and the original CLI moves to
	// dist/core-cli.js. Keep the portable-only import dynamic so TypeScript does not
	// require that generated file at source-check time. The standalone Bun build
	// still sees the static ./cli.js import and bundles Core normally.
	const runningAsPortableBin = path.basename(fileURLToPath(import.meta.url)) === "cli.js";
	if (runningAsPortableBin) {
		const portableCoreCli = `./core-${"cli"}.js`;
		await import(portableCoreCli);
		return;
	}
	await import("./cli.js");
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (!shouldTryExternalCommand(command)) {
		await runCoreCli();
		return;
	}

	const host = resolveExternalCommandHost();
	if (!host) {
		await runCoreCli();
		return;
	}

	process.exitCode = runExternalCommand(host, process.argv.slice(2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
