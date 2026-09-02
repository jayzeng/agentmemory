import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";

import {
	getDefaultPluginInstallRoot,
	type PluginAccessDecisionV1,
	type PluginBootstrapBackendV1,
	PluginBootstrapFailure,
	type PluginNextActionV1,
	type PluginSessionUsageDecisionV1,
	type SignedPluginReleaseV1,
} from "./plugin-bootstrap.js";
import { type PluginEntitlementStatusV1, validatePluginEntitlementStatusV1 } from "./plugin-host.js";

const API_ORIGIN = "https://api.agentmemory.paperpilot.me";
const ARTIFACT_ORIGIN = "https://plugins.agentmemory.paperpilot.me";
const ACTIVATION_FILE = "credentials/activation.json";
const ACTIVATION_FILE_LEGACY = "credentials/temporary-access.json";
const REQUEST_TIMEOUT_MS = 30_000;
const EMAIL_MAX_BYTES = 254;
const FORM_MAX_BYTES = 2_048;
const SERVICE_JSON_MAX_BYTES = 1024 * 1024;
const ACTIVATION_CREDENTIAL = /^am_activation_[A-Za-z0-9_-]{32,256}$/;

const MISSING_ENTITLEMENT: PluginEntitlementStatusV1 = {
	plan: null,
	state: "missing",
	features: [],
	capabilities: {},
	reason: "Install the no-account Pro preview to activate local recall and learning",
};

interface LocalActivationV1 {
	schemaVersion: 3;
	installationId: string;
	activatedAt: string;
	usageCredential: string;
	dailySessionLimit: number;
}

interface AgentMemoryServiceBackendOptions {
	root?: string;
	coreVersion?: string;
	apiOrigin?: string;
	artifactOrigin?: string;
	fetch?: typeof globalThis.fetch;
	openUrl?: (url: string) => boolean;
	activate?: () => Promise<string>;
}

function cloneEntitlement(value: PluginEntitlementStatusV1): PluginEntitlementStatusV1 {
	return structuredClone(value);
}

function freeEntitlement(): PluginEntitlementStatusV1 {
	return {
		plan: "free",
		state: "active",
		features: ["session-intelligence", "web-console"],
		capabilities: {
			"session-index": { enabled: true },
			recall: { enabled: true, quota: { limit: 20, window: "day", scope: "device" } },
			"session-worker": { enabled: false },
			learning: { enabled: true, quota: { limit: 5, window: "day", scope: "device" } },
			"retrieval-evaluation": { enabled: true },
			"operational-metrics": { enabled: true },
			"web-console": { enabled: true },
			"memory-explorer": { enabled: true },
		},
		reason:
			"Included at no cost: 20 recalls and 5 learning scans per local day; local indexing and dashboard access remain available",
	};
}

function devEntitlement(): PluginEntitlementStatusV1 {
	return {
		plan: "pro",
		state: "active",
		features: ["session-intelligence", "web-console"],
		capabilities: {
			"session-index": { enabled: true },
			recall: { enabled: true },
			"session-worker": { enabled: true },
			learning: { enabled: true },
			"retrieval-evaluation": { enabled: true },
			"operational-metrics": { enabled: true },
			"web-console": { enabled: true },
			"memory-explorer": { enabled: true },
		},
		reason: "Dev entitlement: all capabilities enabled, no quotas (AGENT_MEMORY_DEV_ENTITLEMENT=1)",
	};
}

function isEmail(value: string): boolean {
	return (
		Buffer.byteLength(value, "utf-8") <= EMAIL_MAX_BYTES &&
		[...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
	);
}

function securityHeaders(contentType: string): Record<string, string> {
	return {
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		"Content-Type": contentType,
		"Referrer-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	};
}

const ACTIVATION_PAGE_STYLES = `
:root{color-scheme:light;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb;font-synthesis:none}
*{box-sizing:border-box}
body{min-height:100vh;margin:0;padding:2rem 1.25rem;display:grid;place-items:center;background:radial-gradient(circle at 12% 0%,#e8f0ff 0,transparent 38rem),radial-gradient(circle at 100% 100%,#eef2ff 0,transparent 32rem),#f7f9fc}
main{width:min(100%,34rem)}
.skip-link{position:fixed;z-index:1;top:1rem;left:1rem;padding:.65rem .8rem;border-radius:.55rem;background:#172033;color:#fff;font-weight:700;transform:translateY(-200%)}
.skip-link:focus{transform:translateY(0)}
.brand{display:flex;align-items:center;gap:.75rem;margin:0 0 1.25rem .25rem;color:#33415c;font-size:.875rem;font-weight:700;letter-spacing:.01em}
.mark{width:2.25rem;height:2.25rem;display:grid;place-items:center;border-radius:.7rem;background:linear-gradient(145deg,#172033,#3159b8);color:#fff;box-shadow:0 .5rem 1.25rem rgba(35,65,130,.2);font-size:1.05rem;letter-spacing:-.08em}
.card{padding:clamp(1.5rem,5vw,2.5rem);border:1px solid rgba(205,216,231,.9);border-radius:1.5rem;background:rgba(255,255,255,.94);box-shadow:0 1.5rem 4rem rgba(32,51,84,.12),0 .125rem .375rem rgba(32,51,84,.06);backdrop-filter:blur(1rem)}
.eyebrow{display:inline-flex;align-items:center;gap:.45rem;margin:0 0 1rem;padding:.42rem .7rem;border:1px solid #d9e4f7;border-radius:999px;background:#f3f7ff;color:#315798;font-size:.78rem;font-weight:750;letter-spacing:.03em;text-transform:uppercase}
.eyebrow::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:#2b67d1;box-shadow:0 0 0 .22rem #dbe8ff}
h1{margin:0;color:#141d2c;font-size:clamp(2rem,7vw,2.75rem);line-height:1.06;letter-spacing:-.045em;text-wrap:balance}
.intro{margin:.9rem 0 1.75rem;color:#526176;font-size:1.05rem;line-height:1.55}
form{display:grid;gap:.75rem}
label{color:#29364a;font-size:.9rem;font-weight:700}
input{width:100%;min-height:3.25rem;padding:.8rem 3.5rem .8rem 1rem;border:1px solid #bcc8d8;border-radius:.8rem;background:#fff;color:#172033;font:inherit;box-shadow:inset 0 1px 2px rgba(24,39,65,.04)}
input::placeholder{color:#8a96a7}
input:hover{border-color:#92a2b8}
input:focus-visible{outline:0;border-color:#2b67d1;box-shadow:0 0 0 .25rem rgba(43,103,209,.15)}
button{min-height:3.35rem;margin-top:.25rem;padding:.85rem 1rem;border:1px solid #172033;border-radius:.8rem;background:linear-gradient(180deg,#24334a,#172033);color:#fff;font:inherit;font-weight:750;cursor:pointer;box-shadow:0 .55rem 1.2rem rgba(23,32,51,.18);touch-action:manipulation;transition:transform .15s}
button:hover{background:linear-gradient(180deg,#2d405c,#1d2a40);box-shadow:0 .7rem 1.4rem rgba(23,32,51,.23);transform:translateY(-1px)}
button:active{transform:translateY(0)}
button:focus-visible,summary:focus-visible{outline:.2rem solid rgba(43,103,209,.32);outline-offset:.18rem}
.terminal-note{margin:.8rem 0 0;color:#6a7789;font-size:.85rem;text-align:center}
.error{margin:0 0 1rem;padding:.8rem 1rem;border:1px solid #efb8bd;border-radius:.75rem;background:#fff3f4;color:#982631;font-size:.9rem;line-height:1.45}
details{margin-top:1.5rem;padding-top:1.25rem;border-top:1px solid #e2e8f0;color:#5b687a;font-size:.85rem;line-height:1.55}
summary{color:#46566d;font-weight:700;cursor:pointer;list-style-position:outside;touch-action:manipulation}
details p{margin:.8rem 0 0}
.never-sent{padding:.75rem .85rem;border-radius:.65rem;background:#f5f7fa;color:#536176}
.success{display:grid;place-items:center;width:3.5rem;height:3.5rem;margin-bottom:1.4rem;border-radius:1rem;background:#eaf7ef;color:#197542;font-size:1.65rem;font-weight:800;box-shadow:inset 0 0 0 1px #c9ead6}
.completion .intro{margin-bottom:0}
@media (max-width:30rem){body{padding:1rem}.brand{margin-left:.1rem}.card{border-radius:1.15rem}h1{font-size:2rem}}
@media (prefers-reduced-motion:reduce){input,button{transition:none}}
`;

function activationPage(action: string, error?: string): string {
	const errorHtml = error ? `<p class="error" id="activation-error" role="alert">${error}</p>` : "";
	const describedBy = error ? "activation-error terminal-note" : "terminal-note";
	const autofocus = error ? " autofocus" : "";
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="theme-color" content="#f4f7fb">
	<title>Activate AgentMemory</title>
	<style>${ACTIVATION_PAGE_STYLES}</style>
</head>
<body>
	<a class="skip-link" href="#activation">Skip to Activation</a>
	<main id="activation">
		<div class="brand" translate="no"><span class="mark" aria-hidden="true">AM</span><span>AgentMemory</span></div>
		<section class="card" aria-labelledby="activation-title">
			<p class="eyebrow">Free daily allowance</p>
			<h1 id="activation-title">Activate This Device</h1>
			<p class="intro">Use your email to enable AgentMemory Pro for your local agent sessions.</p>
			<form method="post" action="${action}">
				<label for="email">Email address</label>
				${errorHtml}
				<input id="email" type="email" name="email" autocomplete="email" inputmode="email" spellcheck="false" placeholder="you@example.com…" maxlength="254" required${autofocus} aria-describedby="${describedBy}">
				<button type="submit">Activate AgentMemory</button>
			</form>
			<p class="terminal-note" id="terminal-note">Your terminal will finish setup after activation.</p>
			<details>
				<summary>What’s shared during activation</summary>
				<p>Your email identifies your free daily allowance. The CLI also sends core and bundle versions, platform, architecture, and release channel. The service stores a daily count of opaque session-start operations. Activation records expire after 365 days without use.</p>
				<p class="never-sent"><strong>Never sent:</strong> The request never includes memory, session content, queries, repository paths, raw agent session identifiers, IP addresses, or user-agent strings.</p>
			</details>
		</section>
	</main>
</body>
</html>`;
}

function completionPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="theme-color" content="#f4f7fb">
	<title>AgentMemory activated</title>
	<style>${ACTIVATION_PAGE_STYLES}</style>
</head>
<body>
	<a class="skip-link" href="#completion">Skip to Activation Status</a>
	<main id="completion">
		<div class="brand" translate="no"><span class="mark" aria-hidden="true">AM</span><span>AgentMemory</span></div>
		<section class="card completion" aria-labelledby="completion-title">
			<div class="success" aria-hidden="true">✓</div>
			<p class="eyebrow">Device activated</p>
			<h1 id="completion-title">You’re All Set</h1>
			<p class="intro">Return to your terminal to finish installing AgentMemory Pro. You can close this tab.</p>
		</section>
	</main>
</body>
</html>`;
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8"): void {
	response.writeHead(status, securityHeaders(contentType));
	response.end(body);
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new PluginBootstrapFailure("service_response_too_large", "The plugin service response is too large");
		}
		chunks.push(value);
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await readBoundedBody(response, SERVICE_JSON_MAX_BYTES)));
	} catch (error) {
		if (error instanceof PluginBootstrapFailure) throw error;
		throw new PluginBootstrapFailure("service_response_invalid", "The plugin service returned invalid JSON");
	}
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > FORM_MAX_BYTES) {
				reject(new Error("form too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf-8"))));
		request.on("error", reject);
	});
}

function isSameOriginActivationPost(request: IncomingMessage, expectedHost: string, activationPath: string): boolean {
	const expectedOrigin = `http://${expectedHost}`;
	const origin = request.headers.origin;
	const fetchSite = request.headers["sec-fetch-site"];
	if (origin === "null") {
		return (
			fetchSite === "same-origin" &&
			request.headers["sec-fetch-mode"] === "navigate" &&
			request.headers["sec-fetch-dest"] === "document" &&
			request.headers["sec-fetch-user"] === "?1"
		);
	}
	if (origin !== undefined) return origin === expectedOrigin;

	if (fetchSite !== undefined && fetchSite !== "same-origin") return false;

	const referer = request.headers.referer;
	if (referer !== undefined) {
		try {
			const parsed = new URL(referer);
			return parsed.origin === expectedOrigin && parsed.pathname === activationPath;
		} catch {
			return false;
		}
	}

	// Privacy-focused and older browsers may omit all three headers. The exact
	// loopback Host plus the 192-bit, single-use path remains the CSRF capability.
	return true;
}

export function openLoopbackUrl(url: string): boolean {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return false;
	try {
		const child =
			process.platform === "darwin"
				? spawn("open", [parsed.toString()], { detached: true, stdio: "ignore" })
				: process.platform === "win32"
					? spawn("explorer.exe", [parsed.toString()], { detached: true, stdio: "ignore" })
					: spawn("xdg-open", [parsed.toString()], { detached: true, stdio: "ignore" });
		child.unref();
		return true;
	} catch {
		return false;
	}
}

export async function collectActivation(openUrl: (url: string) => boolean = openLoopbackUrl): Promise<string> {
	const nonce = randomBytes(24).toString("hex");
	const activationPath = `/activate/${nonce}`;
	let expectedHost = "";
	let settle: ((email: string) => void) | null = null;
	let fail: ((error: Error) => void) | null = null;
	const result = new Promise<string>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const server = createServer(async (request, response) => {
		if (request.headers.host !== expectedHost || request.url !== activationPath) {
			send(response, 404, "Not found", "text/plain; charset=utf-8");
			return;
		}
		if (request.method === "GET") {
			send(response, 200, activationPage(activationPath));
			return;
		}
		if (request.method !== "POST" || !isSameOriginActivationPost(request, expectedHost, activationPath)) {
			send(response, 403, "Forbidden", "text/plain; charset=utf-8");
			return;
		}
		try {
			const email = (await readForm(request)).get("email")?.trim() ?? "";
			if (!isEmail(email)) {
				send(response, 400, activationPage(activationPath, "Enter a valid email address."));
				return;
			}
			send(response, 200, completionPage());
			settle?.(email);
			settle = null;
			server.close();
		} catch {
			send(response, 400, activationPage(activationPath, "The activation form could not be read."));
		}
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.maxHeadersCount = 40;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new PluginBootstrapFailure("activation_failed", "Activation did not bind to loopback");
	expectedHost = `127.0.0.1:${address.port}`;
	const url = `http://${expectedHost}${activationPath}`;
	console.log(`AgentMemory activation: ${url}`);
	let opened = false;
	try {
		opened = openUrl(url);
	} catch {
		server.close();
		throw new PluginBootstrapFailure("browser_unavailable", `Open this URL in a browser: ${url}`);
	}
	if (!opened) {
		server.close();
		throw new PluginBootstrapFailure("browser_unavailable", `Open this URL in a browser: ${url}`);
	}
	const timer = setTimeout(() => {
		fail?.(new PluginBootstrapFailure("activation_timeout", "Browser activation timed out", true));
		server.close();
	}, 5 * 60_000);
	timer.unref();
	try {
		return await result;
	} finally {
		clearTimeout(timer);
		server.close();
	}
}

export class AgentMemoryServiceBackend implements PluginBootstrapBackendV1 {
	private readonly root: string;
	private readonly coreVersion: string;
	private readonly apiOrigin: string;
	private readonly artifactOrigin: string;
	private readonly fetchImplementation: typeof globalThis.fetch;
	private readonly openUrl: (url: string) => boolean;
	private readonly activate: () => Promise<string>;

	constructor(options: AgentMemoryServiceBackendOptions = {}) {
		this.root = path.resolve(options.root ?? getDefaultPluginInstallRoot());
		this.coreVersion = options.coreVersion ?? "0.0.0";
		this.apiOrigin = options.apiOrigin ?? API_ORIGIN;
		this.artifactOrigin = options.artifactOrigin ?? ARTIFACT_ORIGIN;
		this.fetchImplementation = options.fetch ?? globalThis.fetch;
		this.openUrl = options.openUrl ?? openLoopbackUrl;
		this.activate = options.activate ?? (async () => `am_install_${randomBytes(24).toString("base64url")}`);
	}

	async getLocalEntitlement(): Promise<PluginEntitlementStatusV1> {
		const activation = this.readActivation();
		if (!activation) return cloneEntitlement(MISSING_ENTITLEMENT);
		if (process.env.AGENT_MEMORY_DEV_ENTITLEMENT === "1") return devEntitlement();
		return freeEntitlement();
	}

	async resolveAccess(request: {
		bundleId: string;
		installedVersion?: string;
		channel: string;
		allowAuthentication: boolean;
	}): Promise<PluginAccessDecisionV1> {
		const activation = this.readActivation();
		const installationId = activation?.installationId ?? (await this.activate());
		const response = await this.request(`${this.apiOrigin}/v1/plugin/access`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 2,
				installationId,
				bundleId: request.bundleId,
				installedVersion: request.installedVersion ?? null,
				coreVersion: this.coreVersion,
				channel: request.channel,
				platform: process.platform,
				architecture: process.arch,
			}),
		});
		const value = (await readJson(response)) as {
			entitlement?: unknown;
			artifactGrant?: unknown;
			usageCredential?: unknown;
		};
		validatePluginEntitlementStatusV1(value.entitlement);
		if (typeof value.artifactGrant !== "string" || !value.artifactGrant)
			throw new PluginBootstrapFailure("service_response_invalid", "The access response omitted its artifact grant");
		if (typeof value.usageCredential !== "string" || !ACTIVATION_CREDENTIAL.test(value.usageCredential))
			throw new PluginBootstrapFailure(
				"service_response_invalid",
				"The access response omitted its usage credential",
			);
		const recallQuota = value.entitlement.capabilities.recall?.quota;
		const learningQuota = value.entitlement.capabilities.learning?.quota;
		if (
			value.entitlement.plan !== "free" ||
			value.entitlement.state !== "active" ||
			value.entitlement.capabilities.recall?.enabled !== true ||
			!recallQuota ||
			value.entitlement.capabilities.learning?.enabled !== true ||
			!learningQuota ||
			value.entitlement.capabilities["session-index"]?.enabled !== true ||
			value.entitlement.capabilities["session-worker"]?.enabled !== false ||
			value.entitlement.capabilities["web-console"]?.enabled !== true
		)
			throw new PluginBootstrapFailure("service_response_invalid", "The free preview policy is invalid");
		this.writeActivation(installationId, value.usageCredential, 1);
		return { kind: "granted", entitlement: value.entitlement, artifactGrant: value.artifactGrant };
	}

	async reserveSession(operationId: string): Promise<PluginSessionUsageDecisionV1> {
		return this.sessionUsage("reserve", operationId);
	}

	async commitSession(operationId: string): Promise<PluginSessionUsageDecisionV1> {
		return this.sessionUsage("commit", operationId);
	}

	async releaseSession(operationId: string): Promise<PluginSessionUsageDecisionV1> {
		return this.sessionUsage("release", operationId);
	}

	async listReleases(request: {
		bundleId: string;
		channel: string;
		artifactGrant: string;
	}): Promise<SignedPluginReleaseV1[]> {
		const response = await this.request(`${this.apiOrigin}/v1/plugin/releases`, {
			headers: { Authorization: `Bearer ${request.artifactGrant}` },
		});
		const value = (await readJson(response)) as { releases?: unknown };
		if (!Array.isArray(value.releases))
			throw new PluginBootstrapFailure("service_response_invalid", "The release response is invalid");
		return value.releases as SignedPluginReleaseV1[];
	}

	async downloadArtifact(request: { release: SignedPluginReleaseV1; artifactGrant: string }): Promise<Uint8Array> {
		const response = await this.request(`${this.artifactOrigin}/v1/artifacts/download`, {
			headers: { Authorization: `Bearer ${request.artifactGrant}` },
		});
		const declared = Number(response.headers.get("Content-Length"));
		if (Number.isFinite(declared) && declared !== request.release.size)
			throw new PluginBootstrapFailure("artifact_size_mismatch", "The artifact response size is invalid");
		const artifact = await readBoundedBody(response, request.release.size);
		if (artifact.byteLength !== request.release.size)
			throw new PluginBootstrapFailure("artifact_size_mismatch", "The artifact response size is invalid");
		return artifact;
	}

	async getManagementAction(): Promise<PluginNextActionV1 | null> {
		return null;
	}

	private activationPath(): string {
		return path.join(this.root, ...ACTIVATION_FILE.split("/"));
	}

	private readActivation(): LocalActivationV1 | null {
		const activationPath = this.activationPath();
		if (!fs.existsSync(activationPath)) {
			const legacyPath = path.join(this.root, ...ACTIVATION_FILE_LEGACY.split("/"));
			if (fs.existsSync(legacyPath)) {
				try {
					fs.renameSync(legacyPath, activationPath);
				} catch {
					/* best-effort migration */
				}
			}
		}
		if (!fs.existsSync(activationPath)) return null;
		try {
			const rootStat = fs.lstatSync(this.root);
			const credentialsStat = fs.lstatSync(path.dirname(activationPath));
			if (
				!rootStat.isDirectory() ||
				rootStat.isSymbolicLink() ||
				!credentialsStat.isDirectory() ||
				credentialsStat.isSymbolicLink()
			)
				return null;
			const stat = fs.lstatSync(activationPath);
			if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
				return null;
			const value = JSON.parse(fs.readFileSync(activationPath, "utf-8")) as LocalActivationV1;
			if (
				value.schemaVersion !== 3 ||
				typeof value.installationId !== "string" ||
				!/^am_install_[A-Za-z0-9_-]{32}$/.test(value.installationId) ||
				!Number.isFinite(Date.parse(value.activatedAt)) ||
				!ACTIVATION_CREDENTIAL.test(value.usageCredential) ||
				!Number.isSafeInteger(value.dailySessionLimit) ||
				value.dailySessionLimit <= 0 ||
				value.dailySessionLimit > 10_000
			)
				return null;
			return value;
		} catch {
			return null;
		}
	}

	private writeActivation(installationId: string, usageCredential: string, dailySessionLimit: number): void {
		if (!/^am_install_[A-Za-z0-9_-]{32}$/.test(installationId))
			throw new PluginBootstrapFailure("activation_failed", "The installation identifier is invalid");
		if (!ACTIVATION_CREDENTIAL.test(usageCredential))
			throw new PluginBootstrapFailure("activation_failed", "The activation credential is invalid");
		if (!Number.isSafeInteger(dailySessionLimit) || dailySessionLimit <= 0 || dailySessionLimit > 10_000)
			throw new PluginBootstrapFailure("activation_failed", "The free session allowance is invalid");
		const target = this.activationPath();
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const rootStat = fs.lstatSync(this.root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
			throw new PluginBootstrapFailure("activation_path_invalid", "The plugin activation root is unsafe");
		const directory = path.dirname(target);
		if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
		const directoryStat = fs.lstatSync(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
			throw new PluginBootstrapFailure("activation_path_invalid", "The plugin activation directory is unsafe");
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		fs.writeFileSync(
			temporary,
			`${JSON.stringify(
				{
					schemaVersion: 3,
					installationId,
					activatedAt: new Date().toISOString(),
					usageCredential,
					dailySessionLimit,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		fs.renameSync(temporary, target);
	}

	private async sessionUsage(
		action: "reserve" | "commit" | "release",
		operationId: string,
	): Promise<PluginSessionUsageDecisionV1> {
		const activation = this.readActivation();
		if (!activation) throw new PluginBootstrapFailure("auth_required", "Run plugin install to activate AgentMemory");
		const response = await this.request(`${this.apiOrigin}/v1/plugin/sessions/${action}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${activation.usageCredential}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ schemaVersion: 1, operationId }),
		});
		const value = (await readJson(response)) as { decision?: Partial<PluginSessionUsageDecisionV1> };
		const decision = value.decision;
		if (
			!decision ||
			typeof decision.allowed !== "boolean" ||
			!["reserved", "committed", "released", "exhausted", "missing"].includes(String(decision.state)) ||
			!Number.isSafeInteger(decision.limit) ||
			Number(decision.limit) <= 0 ||
			!Number.isSafeInteger(decision.used) ||
			Number(decision.used) < 0 ||
			!Number.isSafeInteger(decision.remaining) ||
			Number(decision.remaining) < 0 ||
			typeof decision.resetAt !== "string" ||
			!Number.isFinite(Date.parse(decision.resetAt)) ||
			typeof decision.idempotent !== "boolean"
		)
			throw new PluginBootstrapFailure("service_response_invalid", "The session usage response is invalid");
		return decision as PluginSessionUsageDecisionV1;
	}

	private async request(url: string, init: RequestInit = {}): Promise<Response> {
		let response: Response;
		try {
			response = await this.fetchImplementation(url, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: { Accept: "application/json", ...init.headers },
			});
		} catch {
			throw new PluginBootstrapFailure("service_unavailable", "The AgentMemory plugin service is unavailable", true);
		}
		if (!response.ok) {
			let message = `The AgentMemory plugin service returned HTTP ${response.status}`;
			try {
				const value = (await readJson(response)) as { error?: { message?: unknown } };
				if (typeof value.error?.message === "string") message = value.error.message;
			} catch (error) {
				if (error instanceof PluginBootstrapFailure && error.code === "service_response_too_large") throw error;
				// Keep the bounded generic response.
			}
			throw new PluginBootstrapFailure("service_request_failed", message, response.status >= 500);
		}
		return response;
	}
}

export class TemporaryPluginBackend extends AgentMemoryServiceBackend {
	constructor(options: { root: string; coreVersion: string }) {
		super({ ...options, openUrl: () => false });
	}
}
