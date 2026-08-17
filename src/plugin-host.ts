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

export type PluginPlanV1 = "free" | "trial" | "pro" | "team" | "enterprise";

export interface PluginCapabilityQuotaV1 {
	limit: number;
	window: "day";
	scope: "device";
}

export interface PluginCapabilityGrantV1 {
	enabled: boolean;
	quota?: PluginCapabilityQuotaV1;
}

export interface PluginEntitlementStatusV1 {
	plan: PluginPlanV1 | null;
	state: PluginEntitlementStateV1;
	features: string[];
	capabilities: Record<string, PluginCapabilityGrantV1>;
	expiresAt?: string;
	offlineUntil?: string;
	reason?: string;
}

export interface PluginCommandDescriptorV1 {
	name: string;
	description: string;
	aliases?: string[];
	requiredCapability: string;
}

export interface AgentMemoryPluginManifestV1 {
	schemaVersion: 1;
	id: string;
	name: string;
	version: string;
	description: string;
	engine: string;
	entitlement: "commercial";
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
	requiredCapability: string;
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
const PLANS = new Set<PluginPlanV1>(["free", "trial", "pro", "team", "enterprise"]);
const ENTITLEMENT_STATES = new Set<PluginEntitlementStateV1>(["active", "grace", "missing", "expired"]);

export function validatePluginManifestV1(manifest: AgentMemoryPluginManifestV1): void {
	if (manifest.schemaVersion !== 1) throw new Error(`Unsupported plugin manifest schema for ${manifest.id}`);
	if (!PLUGIN_ID.test(manifest.id)) throw new Error(`Invalid plugin id: ${manifest.id}`);
	if (!manifest.name.trim() || !manifest.description.trim())
		throw new Error(`Plugin manifest ${manifest.id} is incomplete`);
	if (!SEMVER.test(manifest.version))
		throw new Error(`Invalid plugin version for ${manifest.id}: ${manifest.version}`);
	if (!manifest.engine.trim()) throw new Error(`Plugin manifest ${manifest.id} has no engine range`);

	const commands = new Set<string>();
	const capabilities = new Set(manifest.capabilities ?? []);
	if (capabilities.size !== (manifest.capabilities?.length ?? 0))
		throw new Error(`Plugin manifest ${manifest.id} must declare unique capabilities`);
	for (const capability of capabilities) {
		if (!PLUGIN_ID.test(capability)) throw new Error(`Invalid capability '${capability}' in ${manifest.id}`);
	}
	for (const command of manifest.commands) {
		if (!COMMAND_NAME.test(command.name)) throw new Error(`Invalid command '${command.name}' in ${manifest.id}`);
		if (!command.description.trim())
			throw new Error(`Command '${command.name}' in ${manifest.id} has no description`);
		if (commands.has(command.name)) throw new Error(`Duplicate command '${command.name}' in ${manifest.id}`);
		if (!capabilities.has(command.requiredCapability))
			throw new Error(
				`Command '${command.name}' in ${manifest.id} requires undeclared capability '${command.requiredCapability}'`,
			);
		commands.add(command.name);
	}

	for (const dependency of manifest.requires ?? []) {
		if (!PLUGIN_ID.test(dependency)) throw new Error(`Invalid dependency '${dependency}' in ${manifest.id}`);
		if (dependency === manifest.id) throw new Error(`Plugin ${manifest.id} cannot require itself`);
	}
}

export function validatePluginEntitlementStatusV1(
	entitlement: unknown,
): asserts entitlement is PluginEntitlementStatusV1 {
	if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement))
		throw new Error("Plugin entitlement must be an object");
	const candidate = entitlement as Partial<PluginEntitlementStatusV1>;
	if (candidate.plan !== null && !PLANS.has(candidate.plan as PluginPlanV1))
		throw new Error("Plugin entitlement has an invalid plan");
	if (!ENTITLEMENT_STATES.has(candidate.state as PluginEntitlementStateV1))
		throw new Error("Plugin entitlement has an invalid state");
	if (!Array.isArray(candidate.features) || candidate.features.some((feature) => typeof feature !== "string"))
		throw new Error("Plugin entitlement features must be strings");
	if (!candidate.capabilities || typeof candidate.capabilities !== "object" || Array.isArray(candidate.capabilities))
		throw new Error("Plugin entitlement capabilities must be an object");
	for (const [capability, grant] of Object.entries(candidate.capabilities)) {
		if (!PLUGIN_ID.test(capability)) throw new Error(`Invalid entitlement capability: ${capability}`);
		if (!grant || typeof grant !== "object" || Array.isArray(grant) || typeof grant.enabled !== "boolean")
			throw new Error(`Capability ${capability} has an invalid grant`);
		if (grant.quota) {
			if (!Number.isInteger(grant.quota.limit) || grant.quota.limit <= 0)
				throw new Error(`Capability ${capability} has an invalid quota limit`);
			if (grant.quota.window !== "day" || grant.quota.scope !== "device")
				throw new Error(`Capability ${capability} has an invalid quota policy`);
		}
	}
}

export function isPluginCapabilityEnabled(entitlement: PluginEntitlementStatusV1, capability: string): boolean {
	return (
		(entitlement.state === "active" || entitlement.state === "grace") &&
		entitlement.capabilities?.[capability]?.enabled === true
	);
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
