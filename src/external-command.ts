import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CORE_COMMANDS = new Set([
	"help",
	"version",
	"install-skills",
	"uninstall-skills",
	"context",
	"write",
	"read",
	"scratchpad",
	"search",
	"distil",
	"distill",
	"sync",
	"init",
	"status",
]);

const COMMAND_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function shouldTryExternalCommand(command: string | undefined): boolean {
	return Boolean(command && COMMAND_NAME.test(command) && !CORE_COMMANDS.has(command));
}

export function resolveExternalCommandHost(options?: {
	homeDir?: string;
	platform?: NodeJS.Platform;
	isFile?: (target: string) => boolean;
}): string | null {
	const homeDir = options?.homeDir ?? os.homedir();
	const platform = options?.platform ?? process.platform;
	const isFile =
		options?.isFile ??
		((target: string) => {
			try {
				return fs.statSync(target).isFile();
			} catch {
				return false;
			}
		});
	const filename = platform === "win32" ? "agent-memory-extension.exe" : "agent-memory-extension";
	const target = path.join(homeDir, ".agent-memory", "bin", filename);
	return isFile(target) ? target : null;
}

export function runExternalCommand(host: string, argv: string[]): number {
	const result = spawnSync(host, argv, {
		stdio: "inherit",
		env: process.env,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	return result.status ?? 1;
}
