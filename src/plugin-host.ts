export const AGENT_MEMORY_PLUGIN_API_VERSION = 1 as const;

export type PluginPermissionV1 =
	| "memory:read"
	| "memory:write"
	| "memory:correct"
	| "config:read"
	| "config:write"
	| "jobs:run"
	| "sessions:read"
	| "state:write";

export type PluginEntitlementStateV1 = "active" | "grace" | "missing" | "expired";

export interface PluginEntitlementStatusV1 {
	plan: "pro" | "enterprise" | null;
	state: PluginEntitlementStateV1;
	features: string[];
	expiresAt?: string;
	offlineUntil?: string;
	reason?: string;
}

export interface PluginCommandDescriptorV1 {
	name: string;
	description: string;
	aliases?: string[];
}

export interface AgentMemoryPluginManifestV1 {
	schemaVersion: 1;
	id: string;
	name: string;
	version: string;
	description: string;
	engine: string;
	entitlement: "pro";
	commands: PluginCommandDescriptorV1[];
	permissions: PluginPermissionV1[];
	requires?: string[];
	capabilities?: string[];
	optionalCapabilities?: string[];
}

export interface AgentMemoryBundleManifestV1 {
	schemaVersion: 1;
	id: string;
	version: string;
	channel: string;
	core: string;
	pluginApi: 1;
	entrypoint: string;
	plugins: string[];
}

export interface PluginCommandContextV1 {
	args: string[];
	flags: Record<string, string | boolean>;
	signal: AbortSignal;
}

export interface PluginCommandResultV1 {
	ok: boolean;
	data?: unknown;
	error?: PluginStructuredErrorV1;
}

export interface PluginCommandV1 extends PluginCommandDescriptorV1 {
	run(context: PluginCommandContextV1): Promise<PluginCommandResultV1>;
}

export interface PluginSessionStartContextV1 {
	host: string;
	cwd?: string;
	signal: AbortSignal;
}

export interface PluginSessionStartHookV1 {
	name: string;
	run(context: PluginSessionStartContextV1): Promise<void>;
}

export interface PluginMemoryWriteV1 {
	target: "long_term" | "daily" | "topic";
	content: string;
	mode?: "append" | "overwrite";
	topic?: string;
	date?: string;
	sourceUri?: string;
}

export interface PluginMemoryWriteResultV1 {
	ok: boolean;
	path: string;
	redacted: boolean;
}

export interface PluginMemoryCorrectionV1 {
	artifactId: string;
	scope: "daily" | "durable";
	content: string;
	reason?: string;
	sourceUri?: string;
}

export interface PluginMemoryCorrectionResultV1 {
	ok: boolean;
	path: string;
	redacted: boolean;
}

export interface PluginStructuredErrorV1 {
	code: string;
	message: string;
	retryable?: boolean;
}

export interface AgentMemoryPluginHostV1 {
	apiVersion: 1;
	coreVersion: string;
	registerCommand(command: PluginCommandV1): void;
	registerSessionStartHook(hook: PluginSessionStartHookV1): void;
	getStateDirectory(): string;
	getEntitlement(): Promise<PluginEntitlementStatusV1>;
	redactSecrets(value: string): string;
	writeMemory(request: PluginMemoryWriteV1): Promise<PluginMemoryWriteResultV1>;
	correctMemory(request: PluginMemoryCorrectionV1): Promise<PluginMemoryCorrectionResultV1>;
	scheduleSearchRefresh(reason: string): void;
}

export interface AgentMemoryPluginV1 {
	manifest: AgentMemoryPluginManifestV1;
	activate(host: AgentMemoryPluginHostV1): Promise<void>;
	healthCheck(host: AgentMemoryPluginHostV1): Promise<{ ok: boolean; message?: string }>;
}

export interface AgentMemoryPluginBundleV1 {
	apiVersion: 1;
	manifest: AgentMemoryBundleManifestV1;
	plugins: readonly AgentMemoryPluginV1[];
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const COMMAND_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function validatePluginManifestV1(manifest: AgentMemoryPluginManifestV1): void {
	if (manifest.schemaVersion !== 1) throw new Error(`Unsupported plugin manifest schema for ${manifest.id}`);
	if (!PLUGIN_ID.test(manifest.id)) throw new Error(`Invalid plugin id: ${manifest.id}`);
	if (!manifest.name.trim() || !manifest.description.trim())
		throw new Error(`Plugin manifest ${manifest.id} is incomplete`);
	if (!SEMVER.test(manifest.version))
		throw new Error(`Invalid plugin version for ${manifest.id}: ${manifest.version}`);
	if (!manifest.engine.trim()) throw new Error(`Plugin manifest ${manifest.id} has no engine range`);

	const commands = new Set<string>();
	for (const command of manifest.commands) {
		if (!COMMAND_NAME.test(command.name)) throw new Error(`Invalid command '${command.name}' in ${manifest.id}`);
		if (!command.description.trim())
			throw new Error(`Command '${command.name}' in ${manifest.id} has no description`);
		if (commands.has(command.name)) throw new Error(`Duplicate command '${command.name}' in ${manifest.id}`);
		commands.add(command.name);
	}

	for (const dependency of manifest.requires ?? []) {
		if (!PLUGIN_ID.test(dependency)) throw new Error(`Invalid dependency '${dependency}' in ${manifest.id}`);
		if (dependency === manifest.id) throw new Error(`Plugin ${manifest.id} cannot require itself`);
	}
}

export function validateBundleManifestV1(manifest: AgentMemoryBundleManifestV1): void {
	if (manifest.schemaVersion !== 1) throw new Error(`Unsupported bundle manifest schema for ${manifest.id}`);
	if (!PLUGIN_ID.test(manifest.id)) throw new Error(`Invalid bundle id: ${manifest.id}`);
	if (!SEMVER.test(manifest.version))
		throw new Error(`Invalid bundle version for ${manifest.id}: ${manifest.version}`);
	if (manifest.pluginApi !== AGENT_MEMORY_PLUGIN_API_VERSION)
		throw new Error(`Unsupported plugin API ${manifest.pluginApi} for ${manifest.id}`);
	if (!manifest.channel.trim() || !manifest.core.trim())
		throw new Error(`Bundle manifest ${manifest.id} is incomplete`);
	if (!isSafeBundlePath(manifest.entrypoint)) throw new Error(`Invalid bundle entrypoint: ${manifest.entrypoint}`);
	if (!manifest.plugins.length || new Set(manifest.plugins).size !== manifest.plugins.length)
		throw new Error(`Bundle manifest ${manifest.id} must list unique plugins`);
	for (const pluginId of manifest.plugins) {
		if (!PLUGIN_ID.test(pluginId)) throw new Error(`Invalid plugin id in bundle ${manifest.id}: ${pluginId}`);
	}
}

export function isSafeBundlePath(value: string): boolean {
	if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
	const parts = value.split("/");
	return parts.every((part) => /^[0-9A-Za-z@+._-]+$/.test(part) && part !== "." && part !== "..");
}
