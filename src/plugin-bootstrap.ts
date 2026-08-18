import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	AGENT_MEMORY_PLUGIN_API_VERSION,
	type AgentMemoryBundleManifestV1,
	isSafeBundlePath,
	type PluginEntitlementStatusV1,
	validateBundleManifestV1,
} from "./plugin-host.js";
import { TemporaryPluginBackend } from "./plugin-service.js";

export const OFFICIAL_BUNDLE_ID = "agentmemory.pro";
export const OFFICIAL_PLUGIN_IDS = ["agentmemory.session-intelligence", "agentmemory.web-console"] as const;

export type PluginBootstrapResultKindV1 =
	| "not_installed"
	| "installed"
	| "upgraded"
	| "current"
	| "update_available"
	| "uninstalled"
	| "auth_required"
	| "renewal_required"
	| "unavailable";

export interface PluginBootstrapErrorV1 {
	code: string;
	message: string;
	retryable?: boolean;
}

export interface PluginNextActionV1 {
	kind: "authenticate" | "renew" | "manage";
	url: string;
	userCode?: string;
	message?: string;
}

export interface PluginSessionUsageDecisionV1 {
	allowed: boolean;
	state: "reserved" | "committed" | "released" | "exhausted" | "missing";
	limit: number;
	used: number;
	remaining: number;
	resetAt: string;
	idempotent: boolean;
}

export interface PluginInstallReceiptV1 {
	schemaVersion: 1;
	bundleId: string;
	version: string;
	channel: string;
	pluginApi: 1;
	entrypoint: string;
	packageSha256: string;
	installedAt: string;
	previousVersion?: string;
}

export interface PluginSummaryV1 {
	id: string;
	name: string;
	installed: boolean;
	available: boolean;
	entitlement: PluginEntitlementStatusV1["state"];
}

export interface PluginBootstrapResultV1 {
	schemaVersion: 1;
	command: `plugin.${string}`;
	ok: boolean;
	result: PluginBootstrapResultKindV1;
	bundle: {
		id: string;
		previousVersion: string | null;
		version: string | null;
		channel: string;
	} | null;
	entitlement: PluginEntitlementStatusV1;
	plugins?: PluginSummaryV1[];
	nextAction: PluginNextActionV1 | null;
	error?: PluginBootstrapErrorV1;
}

export interface SignedPluginReleaseV1 {
	schemaVersion: 1;
	manifest: AgentMemoryBundleManifestV1;
	platform: string;
	architecture: string;
	packageSha256: string;
	size: number;
	signature: {
		algorithm: "ed25519";
		keyId: string;
		value: string;
	};
}

export interface AgentMemoryPackageFileV1 {
	path: string;
	sha256: string;
	contentBase64: string;
	executable?: boolean;
}

export interface AgentMemoryPackageV1 {
	schemaVersion: 1;
	manifest: AgentMemoryBundleManifestV1;
	files: AgentMemoryPackageFileV1[];
}

export type PluginAccessDecisionV1 =
	| {
			kind: "granted";
			entitlement: PluginEntitlementStatusV1;
			artifactGrant: string;
	  }
	| {
			kind: "auth_required";
			entitlement: PluginEntitlementStatusV1;
			nextAction: PluginNextActionV1;
	  }
	| {
			kind: "renewal_required";
			entitlement: PluginEntitlementStatusV1;
			nextAction: PluginNextActionV1;
	  }
	| {
			kind: "unavailable";
			entitlement: PluginEntitlementStatusV1;
			error: PluginBootstrapErrorV1;
	  };

export interface PluginBootstrapBackendV1 {
	getLocalEntitlement(): Promise<PluginEntitlementStatusV1>;
	resolveAccess(request: {
		bundleId: string;
		installedVersion?: string;
		channel: string;
		allowAuthentication: boolean;
	}): Promise<PluginAccessDecisionV1>;
	listReleases(request: {
		bundleId: string;
		channel: string;
		artifactGrant: string;
	}): Promise<SignedPluginReleaseV1[]>;
	downloadArtifact(request: { release: SignedPluginReleaseV1; artifactGrant: string }): Promise<Uint8Array>;
	reserveSession?(operationId: string): Promise<PluginSessionUsageDecisionV1>;
	commitSession?(operationId: string): Promise<PluginSessionUsageDecisionV1>;
	releaseSession?(operationId: string): Promise<PluginSessionUsageDecisionV1>;
	getManagementAction(): Promise<PluginNextActionV1 | null>;
}

export interface PluginReleaseVerifierV1 {
	verifyRelease(release: SignedPluginReleaseV1): void;
}

export interface PluginInstallStoreV1 {
	readonly root: string;
	readReceipt(bundleId: string): PluginInstallReceiptV1 | null;
	hasInstalledBundle(receipt: PluginInstallReceiptV1): boolean;
	install(
		packageBytes: Uint8Array,
		release: SignedPluginReleaseV1,
		healthCheck?: (directory: string, release: SignedPluginReleaseV1) => Promise<void>,
	): Promise<PluginInstallReceiptV1>;
	uninstall(bundleId: string): PluginInstallReceiptV1 | null;
}

export interface PluginBootstrapOptionsV1 {
	coreVersion: string;
	backend: PluginBootstrapBackendV1;
	verifier: PluginReleaseVerifierV1;
	store: PluginInstallStoreV1;
	platform?: string;
	architecture?: string;
	healthCheck?: (directory: string, release: SignedPluginReleaseV1) => Promise<void>;
}

export interface PluginReconcileOptionsV1 {
	channel?: string;
	allowAuthentication?: boolean;
}

const MISSING_ENTITLEMENT: PluginEntitlementStatusV1 = {
	plan: null,
	state: "missing",
	features: [],
	capabilities: {},
	reason: "No signed AgentMemory commercial entitlement is installed",
};

const OFFICIAL_PLUGINS = [
	{ id: OFFICIAL_PLUGIN_IDS[0], name: "Coding History Recall" },
	{ id: OFFICIAL_PLUGIN_IDS[1], name: "Memory Dashboard" },
] as const;

const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
const PACKAGE_MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const PACKAGE_MAX_FILES = 10_000;
const TEMPORARY_RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASefZFUVFy1EmvGbd0ckHZThmPgqQ3u9HCwZRReAZQW8=
-----END PUBLIC KEY-----`;

export class PluginBootstrapFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "PluginBootstrapFailure";
	}
}

export class UnavailablePluginBackend implements PluginBootstrapBackendV1 {
	async getLocalEntitlement(): Promise<PluginEntitlementStatusV1> {
		return structuredClone(MISSING_ENTITLEMENT);
	}

	async resolveAccess(): Promise<PluginAccessDecisionV1> {
		return {
			kind: "unavailable",
			entitlement: structuredClone(MISSING_ENTITLEMENT),
			error: {
				code: "service_not_configured",
				message: "The AgentMemory commercial service is not configured in this build",
			},
		};
	}

	async listReleases(): Promise<SignedPluginReleaseV1[]> {
		return [];
	}

	async downloadArtifact(): Promise<Uint8Array> {
		throw new PluginBootstrapFailure(
			"service_not_configured",
			"The AgentMemory commercial service is not configured in this build",
		);
	}

	async getManagementAction(): Promise<PluginNextActionV1 | null> {
		return null;
	}
}

export class RejectingReleaseVerifier implements PluginReleaseVerifierV1 {
	verifyRelease(): void {
		throw new PluginBootstrapFailure("signing_keys_unavailable", "No commercial release signing keys are configured");
	}
}

export class Ed25519ReleaseVerifier implements PluginReleaseVerifierV1 {
	private readonly keys = new Map<string, ReturnType<typeof createPublicKey>>();

	constructor(keys: Record<string, string | Buffer>) {
		for (const [keyId, key] of Object.entries(keys)) this.keys.set(keyId, createPublicKey(key));
	}

	verifyRelease(release: SignedPluginReleaseV1): void {
		validateRelease(release);
		const key = this.keys.get(release.signature.keyId);
		if (!key) throw new PluginBootstrapFailure("unknown_signing_key", "The release uses an unknown signing key");
		const signature = decodeBase64Strict(release.signature.value, "release signature");
		const valid = verify(null, releaseSigningPayload(release), key, signature);
		if (!valid) throw new PluginBootstrapFailure("signature_invalid", "The commercial release signature is invalid");
	}
}

export class FilePluginInstallStore implements PluginInstallStoreV1 {
	readonly root: string;

	constructor(root = getDefaultPluginInstallRoot()) {
		this.root = path.resolve(root);
	}

	readReceipt(bundleId: string): PluginInstallReceiptV1 | null {
		validateId(bundleId, "bundle");
		const receiptPath = this.receiptPath(bundleId);
		if (!fs.existsSync(receiptPath)) return null;
		const stat = fs.lstatSync(receiptPath);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new PluginBootstrapFailure("receipt_invalid", "The plugin install receipt is not a regular file");
		let receipt: PluginInstallReceiptV1;
		try {
			receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as PluginInstallReceiptV1;
		} catch {
			throw new PluginBootstrapFailure("receipt_invalid", "The plugin install receipt is not valid JSON");
		}
		validateReceipt(receipt, bundleId);
		return receipt;
	}

	hasInstalledBundle(receipt: PluginInstallReceiptV1): boolean {
		try {
			const directory = this.versionPath(receipt.bundleId, receipt.version);
			const marker = path.join(directory, ".package-sha256");
			const entrypoint = resolveManagedPath(directory, receipt.entrypoint);
			return (
				fs.lstatSync(directory).isDirectory() &&
				!fs.lstatSync(directory).isSymbolicLink() &&
				fs.lstatSync(entrypoint).isFile() &&
				!fs.lstatSync(entrypoint).isSymbolicLink() &&
				fs.readFileSync(marker, "utf-8").trim() === receipt.packageSha256
			);
		} catch {
			return false;
		}
	}

	async install(
		packageBytes: Uint8Array,
		release: SignedPluginReleaseV1,
		healthCheck: (directory: string, release: SignedPluginReleaseV1) => Promise<void> = defaultHealthCheck,
	): Promise<PluginInstallReceiptV1> {
		validateRelease(release);
		this.ensureRoot();
		const releaseDigest = sha256(packageBytes);
		if (release.size !== packageBytes.byteLength)
			throw new PluginBootstrapFailure(
				"artifact_size_mismatch",
				"The downloaded package size does not match its release",
			);
		if (release.packageSha256 !== releaseDigest)
			throw new PluginBootstrapFailure(
				"artifact_digest_mismatch",
				"The downloaded package digest does not match its release",
			);

		const lock = this.acquireLock();
		const stagingDirectory = path.join(this.root, "staging", `${release.manifest.id}-${randomUUID()}`);
		try {
			const packageValue = decodePluginPackage(packageBytes);
			if (JSON.stringify(packageValue.manifest) !== JSON.stringify(release.manifest))
				throw new PluginBootstrapFailure(
					"package_manifest_mismatch",
					"The package manifest does not match its release",
				);
			extractPackage(packageValue, stagingDirectory);
			fs.writeFileSync(path.join(stagingDirectory, ".package-sha256"), `${releaseDigest}\n`, { mode: 0o600 });
			await healthCheck(stagingDirectory, release);

			const target = this.versionPath(release.manifest.id, release.manifest.version);
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			if (fs.existsSync(target)) {
				const markerPath = path.join(target, ".package-sha256");
				const targetStat = fs.lstatSync(target);
				if (
					targetStat.isSymbolicLink() ||
					!targetStat.isDirectory() ||
					!fs.existsSync(markerPath) ||
					fs.readFileSync(markerPath, "utf-8").trim() !== releaseDigest
				)
					throw new PluginBootstrapFailure(
						"version_conflict",
						"The target plugin version already exists with different contents",
					);
				removeManagedDirectory(this.root, stagingDirectory);
			} else {
				fs.renameSync(stagingDirectory, target);
			}

			const previous = this.readReceipt(release.manifest.id);
			const receipt: PluginInstallReceiptV1 = {
				schemaVersion: 1,
				bundleId: release.manifest.id,
				version: release.manifest.version,
				channel: release.manifest.channel,
				pluginApi: AGENT_MEMORY_PLUGIN_API_VERSION,
				entrypoint: release.manifest.entrypoint,
				packageSha256: release.packageSha256,
				installedAt: new Date().toISOString(),
				...(previous && previous.version !== release.manifest.version ? { previousVersion: previous.version } : {}),
			};
			this.writeReceipt(receipt);
			return receipt;
		} finally {
			if (fs.existsSync(stagingDirectory)) {
				try {
					removeManagedDirectory(this.root, stagingDirectory);
				} catch {
					// Preserve the primary failure. Staging remains inert because no receipt references it.
				}
			}
			this.releaseLock(lock);
		}
	}

	uninstall(bundleId: string): PluginInstallReceiptV1 | null {
		validateId(bundleId, "bundle");
		this.ensureRoot();
		const lock = this.acquireLock();
		try {
			const receipt = this.readReceipt(bundleId);
			if (!receipt) return null;
			const versions = path.join(this.root, "bundles", bundleId);
			if (fs.existsSync(versions)) removeManagedDirectory(this.root, versions);
			fs.unlinkSync(this.receiptPath(bundleId));
			return receipt;
		} finally {
			this.releaseLock(lock);
		}
	}

	private ensureRoot(): void {
		ensureRegularDirectory(this.root, true);
		ensureRegularDirectory(path.join(this.root, "receipts"));
		ensureRegularDirectory(path.join(this.root, "staging"));
		ensureRegularDirectory(path.join(this.root, "bundles"));
	}

	private receiptPath(bundleId: string): string {
		return resolveManagedPath(this.root, `receipts/${bundleId}.json`);
	}

	private versionPath(bundleId: string, version: string): string {
		validateId(bundleId, "bundle");
		validateVersion(version);
		return resolveManagedPath(this.root, `bundles/${bundleId}/${version}`);
	}

	private writeReceipt(receipt: PluginInstallReceiptV1): void {
		const target = this.receiptPath(receipt.bundleId);
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, target);
	}

	private acquireLock(): { descriptor: number; path: string } {
		const lockPath = path.join(this.root, "install.lock");
		try {
			const descriptor = fs.openSync(lockPath, "wx", 0o600);
			fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
			return { descriptor, path: lockPath };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new PluginBootstrapFailure(
					"install_in_progress",
					"Another plugin installation is already in progress",
					true,
				);
			throw error;
		}
	}

	private releaseLock(lock: { descriptor: number; path: string }): void {
		try {
			fs.closeSync(lock.descriptor);
		} catch {
			// Preserve the primary install result; a later command will report a retained lock.
		}
		try {
			fs.unlinkSync(lock.path);
		} catch {
			// Preserve the primary install result; a later command will report a retained lock.
		}
	}
}

export class PluginBootstrapV1 {
	private readonly platform: string;
	private readonly architecture: string;

	constructor(private readonly options: PluginBootstrapOptionsV1) {
		this.platform = options.platform ?? process.platform;
		this.architecture = options.architecture ?? process.arch;
	}

	async list(): Promise<PluginBootstrapResultV1> {
		const receipt = this.validReceipt();
		const entitlement = await this.options.backend.getLocalEntitlement();
		const available = Boolean(receipt) && isEntitled(entitlement);
		return this.result("plugin.list", receipt ? "current" : "not_installed", true, receipt, entitlement, {
			plugins: OFFICIAL_PLUGINS.map((plugin) => ({
				...plugin,
				installed: Boolean(receipt),
				available,
				entitlement: entitlement.state,
			})),
		});
	}

	async status(channel = "stable"): Promise<PluginBootstrapResultV1> {
		const receipt = this.validReceipt();
		const entitlement = await this.options.backend.getLocalEntitlement();
		if (!receipt) return this.result("plugin.status", "not_installed", true, null, entitlement);
		if (!isEntitled(entitlement))
			return this.result(
				"plugin.status",
				entitlement.state === "expired" ? "renewal_required" : "unavailable",
				true,
				receipt,
				entitlement,
			);

		try {
			const access = await this.options.backend.resolveAccess({
				bundleId: OFFICIAL_BUNDLE_ID,
				installedVersion: receipt.version,
				channel,
				allowAuthentication: false,
			});
			if (access.kind !== "granted") return this.result("plugin.status", "current", true, receipt, entitlement);
			const release = await this.selectRelease(channel, access.artifactGrant);
			if (release && compareVersions(release.manifest.version, receipt.version) > 0)
				return this.result("plugin.status", "update_available", true, receipt, entitlement);
		} catch {
			// Status stays useful offline. Install/update surfaces the detailed service error.
		}
		return this.result("plugin.status", "current", true, receipt, entitlement);
	}

	async install(options: PluginReconcileOptionsV1 = {}): Promise<PluginBootstrapResultV1> {
		return this.reconcile("plugin.install", true, options);
	}

	async update(options: PluginReconcileOptionsV1 = {}): Promise<PluginBootstrapResultV1> {
		if (!this.validReceipt()) {
			return this.failure(
				"plugin.update",
				"not_installed",
				await this.options.backend.getLocalEntitlement(),
				"plugin_not_installed",
				"AgentMemory Pro is not installed; run `agent-memory plugin install` first",
			);
		}
		return this.reconcile("plugin.update", false, options);
	}

	async uninstall(): Promise<PluginBootstrapResultV1> {
		const entitlement = await this.options.backend.getLocalEntitlement();
		const removed = this.options.store.uninstall(OFFICIAL_BUNDLE_ID);
		if (!removed) return this.result("plugin.uninstall", "not_installed", true, null, entitlement);
		return this.result("plugin.uninstall", "uninstalled", true, removed, entitlement, { version: null });
	}

	async manage(): Promise<PluginBootstrapResultV1> {
		const receipt = this.validReceipt();
		const entitlement = await this.options.backend.getLocalEntitlement();
		const nextAction = await this.options.backend.getManagementAction();
		if (!nextAction)
			return this.failure(
				"plugin.manage",
				"unavailable",
				entitlement,
				"service_not_configured",
				"AgentMemory account management is not configured in this build",
				receipt,
			);
		return this.result("plugin.manage", receipt ? "current" : "not_installed", true, receipt, entitlement, {
			nextAction,
		});
	}

	private async reconcile(
		command: "plugin.install" | "plugin.update",
		allowAuthentication: boolean,
		options: PluginReconcileOptionsV1,
	): Promise<PluginBootstrapResultV1> {
		const channel = options.channel ?? "stable";
		const previous = this.validReceipt();
		try {
			const access = await this.options.backend.resolveAccess({
				bundleId: OFFICIAL_BUNDLE_ID,
				installedVersion: previous?.version,
				channel,
				allowAuthentication: allowAuthentication && options.allowAuthentication !== false,
			});
			if (access.kind === "auth_required" || access.kind === "renewal_required")
				return this.result(command, access.kind, false, previous, access.entitlement, {
					nextAction: access.nextAction,
					error: {
						code: access.kind,
						message: access.nextAction.message ?? "User action is required before installation can continue",
					},
				});
			if (access.kind === "unavailable")
				return this.result(command, "unavailable", false, previous, access.entitlement, { error: access.error });

			const release = await this.selectRelease(channel, access.artifactGrant);
			if (!release)
				return this.failure(
					command,
					"unavailable",
					access.entitlement,
					"compatible_release_not_found",
					"No signed AgentMemory Pro release is compatible with this core and platform",
					previous,
				);
			if (
				previous &&
				previous.version === release.manifest.version &&
				this.options.store.hasInstalledBundle(previous)
			)
				return this.result(command, "current", true, previous, access.entitlement);

			this.options.verifier.verifyRelease(release);
			const packageBytes = await this.options.backend.downloadArtifact({
				release,
				artifactGrant: access.artifactGrant,
			});
			const installed = await this.options.store.install(packageBytes, release, this.options.healthCheck);
			return this.result(command, previous ? "upgraded" : "installed", true, installed, access.entitlement, {
				previousVersion: previous?.version ?? null,
			});
		} catch (error) {
			const failure = normalizeFailure(error);
			return this.failure(
				command,
				"unavailable",
				await this.options.backend.getLocalEntitlement(),
				failure.code,
				failure.message,
				previous,
				failure.retryable,
			);
		}
	}

	private async selectRelease(channel: string, artifactGrant: string): Promise<SignedPluginReleaseV1 | null> {
		const releases = await this.options.backend.listReleases({
			bundleId: OFFICIAL_BUNDLE_ID,
			channel,
			artifactGrant,
		});
		const compatible: SignedPluginReleaseV1[] = [];
		let verificationFailure: PluginBootstrapFailure | null = null;
		for (const release of releases) {
			try {
				validateRelease(release);
			} catch {
				continue;
			}
			if (
				release.manifest.id !== OFFICIAL_BUNDLE_ID ||
				release.manifest.channel !== channel ||
				release.manifest.pluginApi !== AGENT_MEMORY_PLUGIN_API_VERSION ||
				(release.platform !== "any" && release.platform !== this.platform) ||
				(release.architecture !== "any" && release.architecture !== this.architecture) ||
				!supportsVersionRange(release.manifest.core, this.options.coreVersion)
			)
				continue;
			try {
				this.options.verifier.verifyRelease(release);
				compatible.push(release);
			} catch (error) {
				verificationFailure ??= normalizeFailure(error);
			}
		}
		if (!compatible.length && verificationFailure) throw verificationFailure;
		return (
			compatible.sort((left, right) => compareVersions(right.manifest.version, left.manifest.version))[0] ?? null
		);
	}

	private validReceipt(): PluginInstallReceiptV1 | null {
		const receipt = this.options.store.readReceipt(OFFICIAL_BUNDLE_ID);
		return receipt && this.options.store.hasInstalledBundle(receipt) ? receipt : null;
	}

	private result(
		command: `plugin.${string}`,
		result: PluginBootstrapResultKindV1,
		ok: boolean,
		receipt: PluginInstallReceiptV1 | null,
		entitlement: PluginEntitlementStatusV1,
		overrides: {
			previousVersion?: string | null;
			version?: string | null;
			plugins?: PluginSummaryV1[];
			nextAction?: PluginNextActionV1 | null;
			error?: PluginBootstrapErrorV1;
		} = {},
	): PluginBootstrapResultV1 {
		return {
			schemaVersion: 1,
			command,
			ok,
			result,
			bundle: receipt
				? {
						id: receipt.bundleId,
						previousVersion: overrides.previousVersion ?? receipt.previousVersion ?? null,
						version: overrides.version === undefined ? receipt.version : overrides.version,
						channel: receipt.channel,
					}
				: null,
			entitlement: structuredClone(entitlement),
			...(overrides.plugins ? { plugins: overrides.plugins } : {}),
			nextAction: overrides.nextAction ?? null,
			...(overrides.error ? { error: overrides.error } : {}),
		};
	}

	private failure(
		command: `plugin.${string}`,
		result: PluginBootstrapResultKindV1,
		entitlement: PluginEntitlementStatusV1,
		code: string,
		message: string,
		receipt: PluginInstallReceiptV1 | null = null,
		retryable = false,
	): PluginBootstrapResultV1 {
		return this.result(command, result, false, receipt, entitlement, {
			error: { code, message, ...(retryable ? { retryable } : {}) },
		});
	}
}

export function createDefaultPluginBootstrap(coreVersion: string): PluginBootstrapV1 {
	const store = new FilePluginInstallStore();
	const backend = new TemporaryPluginBackend({ root: store.root, coreVersion });
	return new PluginBootstrapV1({
		coreVersion,
		backend,
		verifier: new Ed25519ReleaseVerifier({ "agentmemory-temporary-2026-08": TEMPORARY_RELEASE_PUBLIC_KEY }),
		store,
		healthCheck: async (directory, release) => {
			const { createInstalledBundleHealthCheck } = await import("./plugin-runtime.js");
			await createInstalledBundleHealthCheck(coreVersion, backend, store.root)(directory, release);
		},
	});
}

export function getDefaultPluginInstallRoot(): string {
	const override = process.env.AGENT_MEMORY_PLUGIN_DIR?.trim();
	return path.resolve(override || path.join(os.homedir(), ".agent-memory", "system", "plugins"));
}

export function encodePluginPackage(packageValue: AgentMemoryPackageV1): Uint8Array {
	validatePackage(packageValue);
	return Buffer.from(`${JSON.stringify(packageValue)}\n`, "utf-8");
}

export function releaseSigningPayload(release: SignedPluginReleaseV1): Uint8Array {
	return Buffer.from(
		JSON.stringify({
			schemaVersion: release.schemaVersion,
			manifest: release.manifest,
			platform: release.platform,
			architecture: release.architecture,
			packageSha256: release.packageSha256,
			size: release.size,
		}),
		"utf-8",
	);
}

export function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function compareVersions(left: string, right: string): number {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	for (let index = 0; index < 3; index++) {
		if (leftParts[index] > rightParts[index]) return 1;
		if (leftParts[index] < rightParts[index]) return -1;
	}
	return 0;
}

export function supportsVersionRange(range: string, version: string): boolean {
	const clauses = range.trim().split(/\s+/).filter(Boolean);
	if (!clauses.length) return false;
	return clauses.every((clause) => {
		const match = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(clause);
		if (!match) return false;
		const comparison = compareVersions(version, match[2]);
		switch (match[1] ?? "=") {
			case ">=":
				return comparison >= 0;
			case ">":
				return comparison > 0;
			case "<=":
				return comparison <= 0;
			case "<":
				return comparison < 0;
			default:
				return comparison === 0;
		}
	});
}

function validateRelease(release: SignedPluginReleaseV1): void {
	if (release.schemaVersion !== 1) throw new PluginBootstrapFailure("release_invalid", "Unsupported release schema");
	validateBundleManifestV1(release.manifest);
	if (!release.platform.trim() || !release.architecture.trim())
		throw new PluginBootstrapFailure("release_invalid", "Release platform metadata is incomplete");
	if (!/^[a-f0-9]{64}$/.test(release.packageSha256))
		throw new PluginBootstrapFailure("release_invalid", "Release package digest is invalid");
	if (!Number.isSafeInteger(release.size) || release.size <= 0 || release.size > PACKAGE_MAX_BYTES)
		throw new PluginBootstrapFailure("release_invalid", "Release package size is invalid");
	if (release.signature.algorithm !== "ed25519" || !release.signature.keyId.trim() || !release.signature.value.trim())
		throw new PluginBootstrapFailure("release_invalid", "Release signature metadata is invalid");
}

function decodePluginPackage(packageBytes: Uint8Array): AgentMemoryPackageV1 {
	if (packageBytes.byteLength > PACKAGE_MAX_BYTES)
		throw new PluginBootstrapFailure("package_too_large", "The plugin package exceeds the compressed-size limit");
	let value: AgentMemoryPackageV1;
	try {
		value = JSON.parse(Buffer.from(packageBytes).toString("utf-8")) as AgentMemoryPackageV1;
	} catch {
		throw new PluginBootstrapFailure("package_invalid", "The plugin package is not valid JSON");
	}
	validatePackage(value);
	return value;
}

function validatePackage(value: AgentMemoryPackageV1): void {
	if (value.schemaVersion !== 1)
		throw new PluginBootstrapFailure("package_invalid", "Unsupported plugin package schema");
	validateBundleManifestV1(value.manifest);
	if (!Array.isArray(value.files) || !value.files.length || value.files.length > PACKAGE_MAX_FILES)
		throw new PluginBootstrapFailure("package_invalid", "The plugin package file count is invalid");
	const paths = new Set<string>();
	let expandedSize = 0;
	for (const file of value.files) {
		if (!isSafeBundlePath(file.path))
			throw new PluginBootstrapFailure("package_path_invalid", "Plugin package path is unsafe");
		if (paths.has(file.path))
			throw new PluginBootstrapFailure("package_path_duplicate", "Plugin package contains duplicate paths");
		paths.add(file.path);
		if (!/^[a-f0-9]{64}$/.test(file.sha256))
			throw new PluginBootstrapFailure("package_invalid", `Plugin package digest is invalid for ${file.path}`);
		const content = decodeBase64Strict(file.contentBase64, `content for ${file.path}`);
		expandedSize += content.byteLength;
		if (expandedSize > PACKAGE_MAX_EXPANDED_BYTES)
			throw new PluginBootstrapFailure("package_too_large", "The plugin package exceeds the expanded-size limit");
		if (sha256(content) !== file.sha256)
			throw new PluginBootstrapFailure(
				"package_file_digest_mismatch",
				`Plugin package file digest failed for ${file.path}`,
			);
	}
	if (!paths.has(value.manifest.entrypoint))
		throw new PluginBootstrapFailure(
			"package_entrypoint_missing",
			"The plugin package does not contain its entrypoint",
		);
}

function extractPackage(packageValue: AgentMemoryPackageV1, stagingDirectory: string): void {
	fs.mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });
	for (const file of packageValue.files) {
		const target = resolveManagedPath(stagingDirectory, file.path);
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, decodeBase64Strict(file.contentBase64, `content for ${file.path}`), {
			mode: file.executable ? 0o755 : 0o644,
			flag: "wx",
		});
	}
}

async function defaultHealthCheck(directory: string, release: SignedPluginReleaseV1): Promise<void> {
	const entrypoint = resolveManagedPath(directory, release.manifest.entrypoint);
	const stat = fs.lstatSync(entrypoint);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new PluginBootstrapFailure("health_check_failed", "The plugin entrypoint is not a regular file");
}

function validateReceipt(receipt: PluginInstallReceiptV1, expectedBundleId: string): void {
	if (receipt.schemaVersion !== 1 || receipt.bundleId !== expectedBundleId)
		throw new PluginBootstrapFailure("receipt_invalid", "The plugin install receipt has the wrong identity");
	validateId(receipt.bundleId, "bundle");
	validateVersion(receipt.version);
	if (!receipt.channel.trim() || receipt.pluginApi !== AGENT_MEMORY_PLUGIN_API_VERSION)
		throw new PluginBootstrapFailure("receipt_invalid", "The plugin install receipt is incompatible");
	if (!isSafeBundlePath(receipt.entrypoint) || !/^[a-f0-9]{64}$/.test(receipt.packageSha256))
		throw new PluginBootstrapFailure(
			"receipt_invalid",
			"The plugin install receipt contains invalid paths or digests",
		);
}

function validateId(value: string, label: string): void {
	if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
		throw new PluginBootstrapFailure(`${label}_id_invalid`, `Invalid ${label} id: ${value}`);
}

function validateVersion(value: string): void {
	parseVersion(value);
}

function parseVersion(value: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
	if (!match) throw new PluginBootstrapFailure("version_invalid", `Invalid semantic version: ${value}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function resolveManagedPath(root: string, relative: string): string {
	if (!isSafeBundlePath(relative)) throw new PluginBootstrapFailure("path_invalid", "Managed plugin path is unsafe");
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(resolvedRoot, ...relative.split("/"));
	if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`))
		throw new PluginBootstrapFailure("path_invalid", "Managed plugin path escapes its root");
	return resolved;
}

function ensureRegularDirectory(directory: string, recursive = false): void {
	if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive, mode: 0o700 });
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new PluginBootstrapFailure(
			"install_root_invalid",
			"The plugin install root and its managed directories must be regular directories",
		);
}

function removeManagedDirectory(root: string, target: string): void {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`))
		throw new PluginBootstrapFailure("path_invalid", "Refusing to remove a path outside the plugin install root");
	const stat = fs.lstatSync(resolvedTarget);
	if (stat.isSymbolicLink()) throw new PluginBootstrapFailure("path_invalid", "Refusing to remove a symbolic link");
	if (!stat.isDirectory())
		throw new PluginBootstrapFailure("path_invalid", "Managed removal target is not a directory");
	fs.rmSync(resolvedTarget, { recursive: true, force: false });
}

function decodeBase64Strict(value: string, label: string): Buffer {
	if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
		throw new PluginBootstrapFailure("base64_invalid", `Invalid base64 ${label}`);
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value)
		throw new PluginBootstrapFailure("base64_invalid", `Non-canonical base64 ${label}`);
	return decoded;
}

function isEntitled(entitlement: PluginEntitlementStatusV1): boolean {
	return entitlement.state === "active" || entitlement.state === "grace";
}

function normalizeFailure(error: unknown): PluginBootstrapFailure {
	if (error instanceof PluginBootstrapFailure) return error;
	return new PluginBootstrapFailure("plugin_install_failed", error instanceof Error ? error.message : String(error));
}
