import { createPublicKey, randomUUID, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	type PluginCapabilityGrantV1,
	type PluginEntitlementStatusV1,
	validatePluginEntitlementStatusV1,
} from "./plugin-host.js";

const DOMAIN = "agentmemory-entitlement-v1\n";
const ENTITLEMENT_FILE = "credentials/entitlement.json";
const INSTALLATION_ID = /^am_install_[A-Za-z0-9_-]{32}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const RELEASE_SIGNING_KEY_2026_08 = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASefZFUVFy1EmvGbd0ckHZThmPgqQ3u9HCwZRReAZQW8=
-----END PUBLIC KEY-----`;

export type EntitlementVerificationKeys = Record<string, string | Buffer>;

export interface SignedEntitlementClaimsV1 {
	schemaVersion: 1;
	installationId: string;
	plan: "free" | "pro";
	features: string[];
	capabilities: Record<string, PluginCapabilityGrantV1>;
	channel: "stable";
	issuedAt: string;
	refreshAfter: string;
	expiresAt: string;
	offlineUntil: string;
}

export interface SignedEntitlementEnvelopeV1 {
	schemaVersion: 1;
	claims: SignedEntitlementClaimsV1;
	signature: {
		algorithm: "ed25519";
		keyId: string;
		value: string;
	};
}

const PINNED_KEYS: EntitlementVerificationKeys = {
	"agentmemory-temporary-2026-08": RELEASE_SIGNING_KEY_2026_08,
};

function parseTime(value: unknown, label: string): number {
	if (typeof value !== "string") throw new Error(`${label} is missing`);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`);
	return timestamp;
}

function validatePolicy(claims: SignedEntitlementClaimsV1): void {
	const candidate: PluginEntitlementStatusV1 = {
		plan: claims.plan,
		state: "active",
		features: claims.features,
		capabilities: claims.capabilities,
		expiresAt: claims.expiresAt,
		offlineUntil: claims.offlineUntil,
	};
	validatePluginEntitlementStatusV1(candidate);
	if (
		claims.capabilities["session-index"]?.enabled !== true ||
		claims.capabilities.recall?.enabled !== true ||
		claims.capabilities.learning?.enabled !== true ||
		claims.capabilities["web-console"]?.enabled !== true ||
		claims.capabilities["memory-explorer"]?.enabled !== true
	)
		throw new Error("required entitlement capabilities are missing");
	if (claims.plan === "pro") {
		if (
			claims.capabilities["session-worker"]?.enabled !== true ||
			claims.capabilities.recall.quota !== undefined ||
			claims.capabilities.learning.quota !== undefined
		)
			throw new Error("Pro entitlement policy is invalid");
		return;
	}
	const recall = claims.capabilities.recall.quota;
	const learning = claims.capabilities.learning.quota;
	if (
		claims.capabilities["session-worker"]?.enabled !== false ||
		recall?.limit !== 20 ||
		recall.window !== "day" ||
		recall.scope !== "device" ||
		learning?.limit !== 5 ||
		learning.window !== "day" ||
		learning.scope !== "device"
	)
		throw new Error("free entitlement policy is invalid");
}

export function verifySignedEntitlementV1(
	value: unknown,
	expectedInstallationId: string,
	now: Date,
	keys: EntitlementVerificationKeys = PINNED_KEYS,
): PluginEntitlementStatusV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("signed entitlement is invalid");
	const envelope = value as Partial<SignedEntitlementEnvelopeV1>;
	if (
		envelope.schemaVersion !== 1 ||
		!envelope.claims ||
		typeof envelope.claims !== "object" ||
		Array.isArray(envelope.claims) ||
		!envelope.signature ||
		typeof envelope.signature !== "object" ||
		Array.isArray(envelope.signature)
	)
		throw new Error("signed entitlement is invalid");
	const claims = envelope.claims as SignedEntitlementClaimsV1;
	if (
		claims.schemaVersion !== 1 ||
		claims.installationId !== expectedInstallationId ||
		!INSTALLATION_ID.test(claims.installationId) ||
		(claims.plan !== "free" && claims.plan !== "pro") ||
		claims.channel !== "stable" ||
		!Array.isArray(claims.features) ||
		!claims.capabilities ||
		typeof claims.capabilities !== "object" ||
		Array.isArray(claims.capabilities)
	)
		throw new Error("signed entitlement claims are invalid");
	const issuedAt = parseTime(claims.issuedAt, "issuedAt");
	const refreshAfter = parseTime(claims.refreshAfter, "refreshAfter");
	const expiresAt = parseTime(claims.expiresAt, "expiresAt");
	const offlineUntil = parseTime(claims.offlineUntil, "offlineUntil");
	if (!(issuedAt <= refreshAfter && refreshAfter <= offlineUntil && offlineUntil <= expiresAt))
		throw new Error("signed entitlement time bounds are invalid");
	if (issuedAt > now.getTime() + 5 * 60_000) throw new Error("signed entitlement was issued in the future");
	const signature = envelope.signature as SignedEntitlementEnvelopeV1["signature"];
	if (
		signature.algorithm !== "ed25519" ||
		typeof signature.keyId !== "string" ||
		typeof signature.value !== "string" ||
		!SIGNATURE.test(signature.value)
	)
		throw new Error("signed entitlement signature is invalid");
	const pem = keys[signature.keyId];
	if (!pem) throw new Error("signed entitlement uses an unknown key");
	const valid = verify(
		null,
		Buffer.from(`${DOMAIN}${JSON.stringify(claims)}`),
		createPublicKey(pem),
		Buffer.from(signature.value, "base64"),
	);
	if (!valid) throw new Error("signed entitlement signature verification failed");
	validatePolicy(claims);
	const timestamp = now.getTime();
	const state: PluginEntitlementStatusV1["state"] =
		timestamp > expiresAt || timestamp > offlineUntil ? "expired" : timestamp > refreshAfter ? "grace" : "active";
	return {
		plan: claims.plan,
		state,
		features: [...claims.features],
		capabilities: structuredClone(claims.capabilities),
		expiresAt: claims.expiresAt,
		offlineUntil: claims.offlineUntil,
		reason:
			state === "active"
				? "Verified signed AgentMemory entitlement"
				: state === "grace"
					? `Using the last verified entitlement offline through ${claims.offlineUntil}`
					: "The last verified offline entitlement has expired",
	};
}

export class SignedEntitlementCache {
	constructor(
		private readonly root: string,
		private readonly keys: EntitlementVerificationKeys = PINNED_KEYS,
	) {}

	read(expectedInstallationId: string, now: Date): PluginEntitlementStatusV1 | null {
		const envelope = this.readEnvelope();
		if (!envelope) return null;
		try {
			return verifySignedEntitlementV1(envelope, expectedInstallationId, now, this.keys);
		} catch {
			return null;
		}
	}

	write(value: unknown, expectedInstallationId: string, now: Date): PluginEntitlementStatusV1 {
		const entitlement = verifySignedEntitlementV1(value, expectedInstallationId, now, this.keys);
		const target = this.path();
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		const directory = fs.lstatSync(path.dirname(target));
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new Error("entitlement credential directory is unsafe");
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		try {
			fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			fs.renameSync(temporary, target);
		} finally {
			try {
				if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
			} catch {
				// Preserve the original persistence failure.
			}
		}
		return entitlement;
	}

	remove(): void {
		const target = this.path();
		try {
			if (!fs.existsSync(target)) return;
			const stat = fs.lstatSync(target);
			if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(target);
		} catch {
			// Invalid cached data already fails closed; cleanup is best effort.
		}
	}

	private path(): string {
		return path.join(this.root, ...ENTITLEMENT_FILE.split("/"));
	}

	private readEnvelope(): unknown | null {
		const target = this.path();
		if (!fs.existsSync(target)) return null;
		try {
			const directory = fs.lstatSync(path.dirname(target));
			const stat = fs.lstatSync(target);
			if (
				!directory.isDirectory() ||
				directory.isSymbolicLink() ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
			)
				return null;
			return JSON.parse(fs.readFileSync(target, "utf-8"));
		} catch {
			return null;
		}
	}
}
