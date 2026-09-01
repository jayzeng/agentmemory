import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { getMemoryDir, memoryWrite, redactSecrets, scheduleQmdUpdate } from "./core.js";
import {
	FilePluginInstallStore,
	OFFICIAL_BUNDLE_ID,
	type PluginBootstrapBackendV1,
	PluginBootstrapFailure,
	type PluginInstallReceiptV1,
	type PluginInstallStoreV1,
	type PluginSessionUsageDecisionV1,
	type SignedPluginReleaseV1,
} from "./plugin-bootstrap.js";
import {
	AGENT_MEMORY_PLUGIN_API_VERSION,
	type AgentMemoryPluginBundleV1,
	type AgentMemoryPluginHostV1,
	type AgentMemoryPluginManifestV1,
	isPluginCapabilityEnabled,
	type PluginBackgroundRefreshContextV1,
	type PluginBackgroundRefreshHookV1,
	type PluginCommandContextV1,
	type PluginCommandResultV1,
	type PluginCommandV1,
	type PluginContextProviderV1,
	type PluginContextSectionV1,
	type PluginEntitlementStatusV1,
	type PluginMcpToolV1,
	type PluginMemoryCorrectionV1,
	type PluginMemoryWriteV1,
	type PluginSessionStartHookV1,
	validateBundleManifestV1,
	validatePluginEntitlementStatusV1,
	validatePluginManifestV1,
} from "./plugin-host.js";
import { AgentMemoryServiceBackend } from "./plugin-service.js";

interface RegisteredCommand {
	command: PluginCommandV1;
	pluginId: string;
}

interface RegisteredContextProvider {
	provider: PluginContextProviderV1;
	pluginId: string;
}

export interface PluginRuntimeOptionsV1 {
	coreVersion: string;
	store?: PluginInstallStoreV1;
	backend?: PluginBootstrapBackendV1;
}

function assertPermission(manifest: AgentMemoryPluginManifestV1, permission: string): void {
	if (!manifest.permissions.includes(permission as never))
		throw new PluginBootstrapFailure(
			"plugin_permission_denied",
			`Plugin ${manifest.id} did not declare permission ${permission}`,
		);
}

function memoryResult(result: Awaited<ReturnType<typeof memoryWrite>>): {
	ok: boolean;
	path: string;
	redacted: boolean;
} {
	if (result.isError)
		throw new PluginBootstrapFailure("plugin_memory_write_failed", result.text.replace(/^Error:\s*/, ""));
	return {
		ok: true,
		path: typeof result.details.path === "string" ? result.details.path : getMemoryDir(),
		redacted: result.details.redacted === true,
	};
}

async function importBundle(
	directory: string,
	receipt: Pick<PluginInstallReceiptV1, "entrypoint" | "bundleId" | "version">,
): Promise<AgentMemoryPluginBundleV1> {
	let component = path.resolve(directory);
	const rootStat = fs.lstatSync(component);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
		throw new PluginBootstrapFailure("plugin_entrypoint_invalid", "The installed plugin directory is unsafe");
	for (const part of receipt.entrypoint.split("/")) {
		component = path.join(component, part);
		const componentStat = fs.lstatSync(component);
		if (componentStat.isSymbolicLink())
			throw new PluginBootstrapFailure(
				"plugin_entrypoint_invalid",
				"The installed plugin path contains a symbolic link",
			);
	}
	const entrypoint = path.resolve(directory, ...receipt.entrypoint.split("/"));
	if (!entrypoint.startsWith(`${path.resolve(directory)}${path.sep}`))
		throw new PluginBootstrapFailure(
			"plugin_entrypoint_invalid",
			"The installed plugin entrypoint escapes its bundle",
		);
	const stat = fs.lstatSync(entrypoint);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new PluginBootstrapFailure(
			"plugin_entrypoint_invalid",
			"The installed plugin entrypoint is not a regular file",
		);
	const imported = (await import(`${pathToFileURL(entrypoint).href}?v=${encodeURIComponent(receipt.version)}`)) as {
		default?: unknown;
	};
	const bundle = imported.default as AgentMemoryPluginBundleV1 | undefined;
	if (!bundle || bundle.apiVersion !== AGENT_MEMORY_PLUGIN_API_VERSION || !Array.isArray(bundle.plugins))
		throw new PluginBootstrapFailure(
			"plugin_bundle_invalid",
			"The plugin entrypoint did not export a compatible bundle",
		);
	validateBundleManifestV1(bundle.manifest);
	if (bundle.manifest.id !== receipt.bundleId || bundle.manifest.version !== receipt.version)
		throw new PluginBootstrapFailure(
			"plugin_bundle_invalid",
			"The loaded plugin bundle identity does not match its receipt",
		);
	const pluginIds = new Set<string>();
	for (const plugin of bundle.plugins) {
		validatePluginManifestV1(plugin.manifest);
		if (pluginIds.has(plugin.manifest.id))
			throw new PluginBootstrapFailure("plugin_bundle_invalid", "The plugin bundle contains duplicate plugin ids");
		pluginIds.add(plugin.manifest.id);
	}
	if (
		pluginIds.size !== bundle.manifest.plugins.length ||
		bundle.manifest.plugins.some((pluginId) => !pluginIds.has(pluginId))
	)
		throw new PluginBootstrapFailure("plugin_bundle_invalid", "The plugin bundle contents do not match its manifest");
	return bundle;
}

export class InstalledPluginRuntimeV1 {
	private readonly store: PluginInstallStoreV1;
	private readonly backend: PluginBootstrapBackendV1;
	private readonly commands = new Map<string, RegisteredCommand>();
	private readonly hooks: PluginSessionStartHookV1[] = [];
	private readonly backgroundRefreshHooks: PluginBackgroundRefreshHookV1[] = [];
	private readonly contextProviders: RegisteredContextProvider[] = [];
	private readonly mcpTools: PluginMcpToolV1[] = [];
	private readonly mcpStartupHooks: Array<() => void | Promise<void>> = [];
	private loaded = false;

	constructor(private readonly options: PluginRuntimeOptionsV1) {
		this.store = options.store ?? new FilePluginInstallStore();
		this.backend = options.backend ?? new AgentMemoryServiceBackend({ root: this.store.root });
	}

	async load(): Promise<boolean> {
		if (this.loaded) return true;
		const receipt = this.store.readReceipt(OFFICIAL_BUNDLE_ID);
		if (!receipt || !this.store.hasInstalledBundle(receipt)) return false;
		await this.refreshEntitlement();
		const directory = path.join(this.store.root, "bundles", receipt.bundleId, receipt.version);
		const bundle = await importBundle(directory, receipt);
		for (const plugin of bundle.plugins) {
			const host = this.createHost(plugin.manifest);
			await plugin.activate(host);
			const health = await plugin.healthCheck(host);
			if (!health.ok)
				throw new PluginBootstrapFailure(
					"plugin_health_check_failed",
					health.message ?? `Plugin ${plugin.manifest.id} failed its health check`,
				);
		}
		this.loaded = true;
		return true;
	}

	async run(name: string, context: PluginCommandContextV1): Promise<PluginCommandResultV1 | null> {
		if (!(await this.load())) return null;
		const registered = this.commands.get(name);
		if (!registered) return null;
		const entitlement = await this.refreshEntitlement();
		if (!isPluginCapabilityEnabled(entitlement, registered.command.requiredCapability))
			return {
				ok: false,
				error: {
					code: "plugin_capability_denied",
					message: `Capability ${registered.command.requiredCapability} is not enabled for ${registered.pluginId}`,
				},
			};
		return registered.command.run(context);
	}

	async runSessionStart(
		context: Parameters<PluginSessionStartHookV1["run"]>[0],
	): Promise<PluginSessionUsageDecisionV1 | null> {
		if (!(await this.load()) || this.hooks.length === 0) return null;
		const entitlement = await this.refreshEntitlement();
		const eligible = this.hooks.filter((hook) => isPluginCapabilityEnabled(entitlement, hook.requiredCapability));
		if (eligible.length === 0) return null;
		const metered = eligible.some(
			(hook) => entitlement.capabilities[hook.requiredCapability]?.quota?.scope === "account",
		);
		if (!metered) {
			for (const hook of eligible) await hook.run(context);
			return null;
		}
		if (!this.backend.reserveSession || !this.backend.commitSession || !this.backend.releaseSession)
			throw new PluginBootstrapFailure("session_usage_unavailable", "Account session metering is unavailable");
		const operationId = randomUUID();
		const reservation = await this.backend.reserveSession(operationId);
		if (!reservation.allowed) return reservation;
		try {
			for (const hook of eligible) await hook.run(context);
			return await this.backend.commitSession(operationId);
		} catch (error) {
			await this.backend.releaseSession(operationId);
			throw error;
		}
	}

	/**
	 * Fire all registered background-refresh hooks. Un-metered — intended for
	 * per-turn UserPromptSubmit invocation, keeping workers alive across
	 * `/clear` and idle without charging session quota. Failures propagate to
	 * the caller (which is expected to swallow them silently).
	 */
	async refreshBackgroundWorkers(context: PluginBackgroundRefreshContextV1): Promise<void> {
		if (!(await this.load()) || this.backgroundRefreshHooks.length === 0) return;
		const entitlement = await this.refreshEntitlement();
		for (const hook of this.backgroundRefreshHooks) {
			if (!isPluginCapabilityEnabled(entitlement, hook.requiredCapability)) continue;
			await hook.run(context);
		}
	}

	async provideContext(context: {
		host: string;
		cwd?: string;
		query?: string;
		signal: AbortSignal;
	}): Promise<PluginContextSectionV1[]> {
		if (!(await this.load()) || this.contextProviders.length === 0) return [];
		const entitlement = await this.refreshEntitlement();
		const sections: PluginContextSectionV1[] = [];
		for (const registered of this.contextProviders) {
			if (!isPluginCapabilityEnabled(entitlement, registered.provider.requiredCapability)) continue;
			const provided = await registered.provider.provide(context);
			if (!Array.isArray(provided) || provided.length > 16)
				throw new PluginBootstrapFailure(
					"plugin_context_invalid",
					`Plugin ${registered.pluginId} returned invalid context sections`,
				);
			for (const section of provided) {
				if (
					!section ||
					typeof section.id !== "string" ||
					section.id.length === 0 ||
					section.id.length > 256 ||
					typeof section.label !== "string" ||
					section.label.length === 0 ||
					section.label.length > 256 ||
					typeof section.content !== "string" ||
					Buffer.byteLength(section.content, "utf-8") > 64 * 1024 ||
					(section.artifactPath !== undefined &&
						(typeof section.artifactPath !== "string" || section.artifactPath.length > 4_096)) ||
					(section.metadata !== undefined &&
						(!section.metadata || typeof section.metadata !== "object" || Array.isArray(section.metadata)))
				)
					throw new PluginBootstrapFailure(
						"plugin_context_invalid",
						`Plugin ${registered.pluginId} returned an invalid context section`,
					);
				sections.push(structuredClone(section));
			}
		}
		return sections;
	}

	getMcpTools(): PluginMcpToolV1[] {
		return [...this.mcpTools];
	}

	/**
	 * Invoke a registered MCP tool by name, re-checking entitlement on every
	 * call — matching `run()`'s behavior for commands. MCP tools are
	 * registered once at `serve --mcp` startup and the server process can
	 * live for a long session, so a tool's entitlement must be re-verified
	 * per-call rather than trusted from registration time (e.g. a trial
	 * expiring mid-session must actually stop the tool from working).
	 */
	async runMcpTool(name: string, input: Record<string, unknown>): Promise<unknown> {
		if (!(await this.load())) return { error: `Unknown MCP tool: ${name}` };
		const tool = this.mcpTools.find((candidate) => candidate.name === name);
		if (!tool) return { error: `Unknown MCP tool: ${name}` };
		const entitlement = await this.refreshEntitlement();
		if (!isPluginCapabilityEnabled(entitlement, tool.requiredCapability))
			return { error: `Capability ${tool.requiredCapability} is not enabled for the ${name} tool` };
		return tool.run(input);
	}

	async runMcpStartup(): Promise<void> {
		for (const hook of this.mcpStartupHooks) await hook();
	}

	private createHost(manifest: AgentMemoryPluginManifestV1): AgentMemoryPluginHostV1 {
		const descriptors = new Map(manifest.commands.map((command) => [command.name, command]));
		const stateRoot = path.join(this.store.root, "state");
		fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
		const stateRootStat = fs.lstatSync(stateRoot);
		if (!stateRootStat.isDirectory() || stateRootStat.isSymbolicLink())
			throw new PluginBootstrapFailure("plugin_state_invalid", "The plugin state root is unsafe");
		const stateDirectory = path.join(stateRoot, OFFICIAL_BUNDLE_ID);
		if (!fs.existsSync(stateDirectory)) fs.mkdirSync(stateDirectory, { mode: 0o700 });
		const stateDirectoryStat = fs.lstatSync(stateDirectory);
		if (!stateDirectoryStat.isDirectory() || stateDirectoryStat.isSymbolicLink())
			throw new PluginBootstrapFailure("plugin_state_invalid", "The plugin state directory is unsafe");
		return {
			apiVersion: AGENT_MEMORY_PLUGIN_API_VERSION,
			coreVersion: this.options.coreVersion,
			registerCommand: (command) => {
				const descriptor = descriptors.get(command.name);
				if (!descriptor || descriptor.requiredCapability !== command.requiredCapability)
					throw new PluginBootstrapFailure(
						"plugin_command_invalid",
						`Plugin ${manifest.id} registered an undeclared command`,
					);
				const names = [command.name, ...(command.aliases ?? [])];
				for (const name of names) {
					if (this.commands.has(name))
						throw new PluginBootstrapFailure(
							"plugin_command_conflict",
							`Plugin command ${name} is already registered`,
						);
				}
				for (const name of names) this.commands.set(name, { command, pluginId: manifest.id });
			},
			registerSessionStartHook: (hook) => {
				if (!(manifest.capabilities ?? []).includes(hook.requiredCapability))
					throw new PluginBootstrapFailure(
						"plugin_hook_invalid",
						`Plugin ${manifest.id} registered a hook with an undeclared capability`,
					);
				this.hooks.push(hook);
			},
			registerBackgroundRefresh: (hook) => {
				if (!(manifest.capabilities ?? []).includes(hook.requiredCapability))
					throw new PluginBootstrapFailure(
						"plugin_hook_invalid",
						`Plugin ${manifest.id} registered a background refresh hook with an undeclared capability`,
					);
				if (!hook.name || this.backgroundRefreshHooks.some((existing) => existing.name === hook.name))
					throw new PluginBootstrapFailure(
						"plugin_hook_invalid",
						`Plugin background refresh hook ${hook.name || "(unnamed)"} is invalid or already registered`,
					);
				this.backgroundRefreshHooks.push(hook);
			},
			registerContextProvider: (provider) => {
				if (!(manifest.capabilities ?? []).includes(provider.requiredCapability))
					throw new PluginBootstrapFailure(
						"plugin_context_invalid",
						`Plugin ${manifest.id} registered a context provider with an undeclared capability`,
					);
				if (!provider.name || this.contextProviders.some((item) => item.provider.name === provider.name))
					throw new PluginBootstrapFailure(
						"plugin_context_invalid",
						`Plugin context provider ${provider.name || "(unnamed)"} is invalid or already registered`,
					);
				this.contextProviders.push({ provider, pluginId: manifest.id });
			},
			registerMcpTool: (tool) => {
				if (!(manifest.capabilities ?? []).includes(tool.requiredCapability))
					throw new PluginBootstrapFailure(
						"plugin_mcp_tool_invalid",
						`Plugin ${manifest.id} registered an MCP tool with an undeclared capability`,
					);
				if (!tool.name || this.mcpTools.some((existing) => existing.name === tool.name))
					throw new PluginBootstrapFailure(
						"plugin_mcp_tool_invalid",
						`Plugin MCP tool ${tool.name || "(unnamed)"} is invalid or already registered`,
					);
				this.mcpTools.push(tool);
			},
			registerMcpStartup: (fn) => {
				this.mcpStartupHooks.push(fn);
			},
			getStateDirectory: () => stateDirectory,
			getMemoryDirectory: () => {
				assertPermission(manifest, "memory:read");
				return getMemoryDir();
			},
			getEntitlement: async () => structuredClone(await this.refreshEntitlement()),
			redactSecrets: (value) => redactSecrets(value).content,
			writeMemory: async (request: PluginMemoryWriteV1) => {
				assertPermission(manifest, "memory:write");
				return memoryResult(await memoryWrite({ ...request, sessionId: `plugin-${manifest.id}` }));
			},
			correctMemory: async (request: PluginMemoryCorrectionV1) => {
				assertPermission(manifest, "memory:correct");
				const content = `Correction for ${request.artifactId}: ${request.content}${request.reason ? `\nReason: ${request.reason}` : ""}`;
				return memoryResult(
					await memoryWrite({
						target: request.scope === "durable" ? "long_term" : "daily",
						content,
						sessionId: `plugin-${manifest.id}`,
						sourceUri: request.sourceUri,
					}),
				);
			},
			scheduleSearchRefresh: () => {
				assertPermission(manifest, "jobs:run");
				scheduleQmdUpdate();
			},
		};
	}

	private async refreshEntitlement(): Promise<PluginEntitlementStatusV1> {
		const entitlement = await this.backend.getLocalEntitlement();
		validatePluginEntitlementStatusV1(entitlement);
		return entitlement;
	}
}

export function createInstalledBundleHealthCheck(
	coreVersion: string,
	backend: PluginBootstrapBackendV1,
	storeRoot: string,
): (directory: string, release: SignedPluginReleaseV1) => Promise<void> {
	return async (directory, release) => {
		const entitlement = await backend.getLocalEntitlement();
		validatePluginEntitlementStatusV1(entitlement);
		const receipt = {
			bundleId: release.manifest.id,
			version: release.manifest.version,
			entrypoint: release.manifest.entrypoint,
		};
		const bundle = await importBundle(directory, receipt);
		for (const plugin of bundle.plugins) {
			const stateDirectory = path.join(storeRoot, "health", OFFICIAL_BUNDLE_ID);
			const host: AgentMemoryPluginHostV1 = {
				apiVersion: 1,
				coreVersion,
				registerCommand() {},
				registerSessionStartHook() {},
				registerBackgroundRefresh() {},
				getStateDirectory: () => stateDirectory,
				getMemoryDirectory: () => {
					assertPermission(plugin.manifest, "memory:read");
					return getMemoryDir();
				},
				getEntitlement: async () => structuredClone(entitlement),
				redactSecrets: (value) => redactSecrets(value).content,
				async writeMemory() {
					throw new PluginBootstrapFailure("plugin_health_check_invalid", "Health checks cannot write memory");
				},
				async correctMemory() {
					throw new PluginBootstrapFailure("plugin_health_check_invalid", "Health checks cannot correct memory");
				},
				scheduleSearchRefresh() {},
			};
			const health = await plugin.healthCheck(host);
			if (!health.ok)
				throw new PluginBootstrapFailure(
					"plugin_health_check_failed",
					health.message ?? `Plugin ${plugin.manifest.id} failed its health check`,
				);
		}
	};
}
