# Official plugin bootstrap and host contract

## Status

Accepted design on 2026-08-16 and revised on 2026-08-17. The public core implements host types, anonymous preview activation, live catalog and artifact retrieval, Ed25519 release verification, bounded package validation, transactional install, bundle health checks, paid-command dispatch, and SessionStart hook dispatch. The free preview grants 20 device-local recalls and 5 device-local learning scans per local day while keeping indexing and Memory Dashboard visibility available. Account authentication, payment, renewal, and account management remain deferred.

The public `agentmemory` repository and `myagentmemory` npm package remain the free, MIT-licensed core. The public bootstrap client and host contracts are also MIT-licensed. Official commercial implementations and browser assets are built and distributed separately from the private commercial workspace under their own terms. Pricing, the billing provider, device limits, offline-grace duration, and Enterprise contract terms are intentionally not decided here. The temporary beta currently uses allowlisted `*.agentmemory.paperpilot.me` service origins; changing those origins is a public-client release change.

## Decision

The public core will provide a small bootstrap and host surface for signed first-party plugins. It will not contain paid implementations, browser assets, commercial entitlement logic, or a general third-party marketplace.

The primary product-facing command is:

```bash
agent-memory pro install
```

`plugin install` is an idempotent reconcile operation:

| Local state | Entitlement state | Result |
| --- | --- | --- |
| Plugin absent | Active or grace | Install the compatible signed bundle |
| Plugin older than the selected release | Active or grace | Upgrade atomically |
| Plugin current | Active or grace | Report that it is current |
| Any | Missing | Request an anonymous free-preview entitlement and signed artifact grant |
| Any | Expired | Direct the user to renewal; leave core available |
| Incompatible bundle | Any | Leave the current version untouched and explain the required core version |

An absent plugin cannot activate itself. The public bootstrap creates a random installation identifier, obtains a server-issued free-preview policy and short-lived artifact grant, and verifies the release and artifact. A mode-0600 activation record is persisted only after the service accepts the request. After installation, the public host reconstructs the free capability policy in core code and checks required capabilities before commands and hooks. Signed long-lived paid entitlements can extend this record when authentication and payment ship.

## Ownership boundary

The public core owns:

- CLI discovery and bootstrap commands;
- an allowlisted control-plane client;
- credential-store and signed-entitlement persistence abstractions;
- signed catalog and artifact verification;
- transactional install, upgrade, rollback, and uninstall;
- a versioned, permission-checked plugin host API;
- command dispatch to an activated official bundle;
- helpful unavailable-command messages when an official capability is absent.

The commercial distribution owns:

- the proprietary plugin runtime and implementations;
- Session Intelligence and Web Console assets;
- entitlement interpretation beyond the public signed-claim format;
- paid command, hook, worker, and web-server behavior;
- the authenticated website, billing integration, entitlement ledger, and artifact service;
- signed release production and commercial notices.

Core memory operations must continue to work when the service is unreachable, a plugin is absent, an entitlement expires, or an upgrade fails.

## Alternatives rejected for v1

- **Put the bootstrap inside the commercial plugin:** impossible when the plugin is not installed and unable to repair a broken installation.
- **Ship a separate permanent Pro CLI:** duplicates command parsing and core behavior and makes it unclear which `agent-memory` binary owns user data.
- **Bundle paid code in the public package behind an entitlement flag:** exposes the paid implementation under the public artifact and license boundary.
- **Open a checkout page from npm/Homebrew postinstall:** unreliable in non-interactive environments and surprising for users who requested only the core.
- **Use a general remote marketplace immediately:** expands code-loading, sandbox, trust, dependency, and moderation scope before the first-party boundary is proven.
- **Pass license keys as CLI arguments or environment values:** exposes reusable credentials through shell history, process inspection, CI logs, or inherited environments.

## CLI contract

### Bootstrap commands

```text
agent-memory pro
agent-memory pro install
agent-memory pro status
agent-memory pro upgrade
agent-memory pro manage

agent-memory plugin
agent-memory plugin list
agent-memory plugin status
agent-memory plugin install [--channel stable] [--no-browser] [--yes]
agent-memory plugin update [--channel stable]
agent-memory plugin uninstall [--yes]
agent-memory plugin manage [--no-browser]
```

The `pro` namespace is the user-facing surface. The `plugin` namespace remains supported for low-level administration and compatibility.

- `plugin` with no subcommand prints a discovery summary and the next relevant command.
- `list` reports known official plugins and whether each is installed and available. It does not download artifacts or inspect memory.
- `status` is read-only. It reports the installed bundle, selected channel, compatibility, entitlement state, and update availability.
- `install` authenticates when necessary, then installs, upgrades, or reports current state.
- `update` requires an existing installation and never starts a new purchase implicitly.
- `uninstall` removes executable plugin material and the active receipt. It preserves core memory, plugin state, and the permission-restricted activation credential.
- `manage` remains unavailable until authenticated account and billing management exists.

Installed plugins contribute top-level commands including `recall` and `learn`; `dashboard` is a product-facing alias for the lower-level `web` command. Bootstrap command names are reserved by the core and cannot be replaced by a plugin.

The current private compatibility CLI uses `plugin install` and `plugin uninstall` for skill files only. During migration, those meanings move to `install-skills --plugin-only` and `uninstall-skills --plugin-only`; the bootstrap command names above become authoritative.

### Discovery behavior

After a successful interactive `agent-memory init`, the core may print one informational line:

```text
Core remembers what you save. Pro learns from what you do.
Run: agent-memory pro install
```

Top-level help includes a Pro section. Human-readable `status` may include the same recommendation while Pro is not installed. Routine `context`, `read`, `write`, `search`, and scratchpad commands never show commercial prompts.

The free preview does not open a browser or request identity. Browsers remain restricted to explicit `dashboard`, future `pro manage`, and future paid upgrade/authentication flows. Non-interactive and `--json` installs use the same anonymous access request and still fail closed when the commercial service is unavailable.

### Machine-readable output

Every bootstrap command supports `--json` and emits one JSON document with a versioned envelope:

```json
{
  "schemaVersion": 1,
  "command": "plugin.install",
  "ok": true,
  "result": "installed",
  "bundle": {
    "id": "agentmemory.pro",
    "previousVersion": null,
    "version": "1.0.0",
    "channel": "stable"
  },
  "entitlement": {
    "plan": "pro",
    "state": "active",
    "capabilities": {
      "learning": { "enabled": true },
      "web-console": { "enabled": true }
    },
    "expiresAt": "2027-08-16T00:00:00Z",
    "offlineUntil": "2026-09-15T00:00:00Z"
  },
  "nextAction": null
}
```

`result` is one of `not_installed`, `installed`, `upgraded`, `current`, `update_available`, `uninstalled`, `auth_required`, `renewal_required`, or `unavailable`. Failures use `ok: false` plus a stable `error.code` and redacted `error.message`. Output must never contain access tokens, download credentials, signed entitlement contents, local memory paths, or URLs containing bearer credentials.

## Anonymous free-preview flow

1. `agent-memory pro install` creates a random installation identifier locally when no activation record exists.
2. The CLI sends that identifier plus core, installed-bundle, platform, architecture, and release-channel fields to the private control plane. It sends no email, memory, session content, query, repository path, raw agent session identifier, IP address, or user-agent string.
3. The service stores the pseudonymous identifier and only the hash of a random compatibility credential, then returns a free-preview capability policy and short-lived object-bound artifact grant.
4. The CLI validates the explicit free policy: local indexing and Memory Dashboard access, 20 device-local recalls per day, 5 device-local learning scans per day, and no free automatic background worker.
5. Only then does the CLI atomically write a mode-0600 activation record.
6. The CLI verifies the Ed25519-signed release plus package digest and limits, imports it for health checks, and atomically activates the receipt.
7. Device-local quota operations reserve before work, commit after useful work, and release on abstention or failure. A zero-result recall does not consume allowance.

Authentication, payment, renewal, account management, and signed paid entitlements are not implemented yet.

## Future authentication and purchase flow

1. The bootstrap inspects the local install receipt and signed entitlement without loading plugin code.
2. If no usable entitlement or account credential exists, it requests a short-lived device authorization.
3. The CLI prints a verification URL and user code and, for an interactive request, attempts to open the URL.
4. The website authenticates the user and offers AgentMemory Pro or an Enterprise contact/organization path.
5. Successful payment or organization assignment updates the server-side entitlement ledger.
6. The CLI polls within the server-provided interval and deadline. On success, it receives a signed entitlement and a short-lived artifact grant.
7. Installation continues in the same command without asking the user to copy a license key.

Canceling, timing out, or failing payment leaves the machine unchanged. Authentication credentials are never accepted through command-line arguments. The first release should use an operating-system credential store when available and an explicit, permission-restricted fallback when it is not. Credential persistence and fallback behavior must be disclosed before launch.

An Enterprise administrator may pre-provision an organization entitlement or managed installation policy. Enterprise automation must accept a license-file path or managed credential reference, not a raw secret on the command line.

## Control-plane boundary

The service exposes:

- `POST /v1/plugin/access` for an anonymous free-preview policy, compatibility credential, and short-lived artifact grant;
- `POST /v1/plugin/sessions/reserve|commit|release` for migration compatibility with activation-v2 clients;
- `GET /v1/plugin/releases` for an Ed25519-signed release selected from the private R2 catalog;
- `GET|HEAD /v1/artifacts/download` for the exact content-addressed object authorized by the bearer grant.

The access request contains a random installation identifier plus the bounded core, bundle, platform, architecture, and release-channel fields described above. Application payloads contain no email, memory content, search query, session content, path, repository name, raw agent session identifier, qmd data, IP address, or user-agent string. The activation database stores neither IP addresses nor user-agent strings. Future authenticated service responsibilities include:

- create and poll a device authorization;
- read the authenticated principal's effective entitlement;
- fetch a signed release catalog;
- mint a short-lived artifact download grant;
- return the account-management URL;
- support Enterprise organization assignment without consumer checkout.

The bootstrap may send only:

- a random installation identifier;
- core version, plugin-host API version, platform, and architecture;
- requested bundle ID, installed bundle version, and release channel;
- a pseudonymous license or organization identifier;
- protocol nonces, opaque quota operation IDs, and authentication material required for the request.

It must never send memory contents, search queries, session contents, raw agent session identifiers, working-directory names, repository names, filesystem paths, or qmd data. The bounded allowance counter is authorization state, not general product telemetry.

Production builds use an allowlisted HTTPS origin. Development endpoint overrides must be explicit, must not silently affect production builds, and must never weaken TLS verification.

## Signed entitlement contract

The server issues a signed, versioned entitlement containing the minimum claims needed for offline activation:

```json
{
  "schemaVersion": 1,
  "licenseId": "lic_pseudonymous_id",
  "plan": "pro",
  "features": ["session-intelligence", "web-console"],
  "capabilities": {
    "learning": { "enabled": true },
    "web-console": { "enabled": true }
  },
  "channel": "stable",
  "issuedAt": "2026-08-16T00:00:00Z",
  "refreshAfter": "2026-08-23T00:00:00Z",
  "expiresAt": "2027-08-16T00:00:00Z",
  "offlineUntil": "2026-09-15T00:00:00Z"
}
```

It contains no name, email address, billing details, memory identifier, or filesystem information. Plan identifiers (`free`, `trial`, `pro`, `team`, or `enterprise`) are commercial policy; `active`, `grace`, `missing`, and `expired` are separate locally derived verification states and are never inferred from the plan name. Enterprise may satisfy all `pro` capability requirements while adding organization-scoped policy claims.

Capabilities authorize individual commands, hooks, workers, and local API routes. A capability may carry a positive device-local daily quota. The signed policy configures the limit, while usage remains in a crash-safe local ledger; quota accounting does not add product telemetry to the bootstrap protocol. A plan never implicitly enables a capability, and an active entitlement with a disabled or absent capability fails closed for that operation.

The exact signed-envelope format, key custody, rotation procedure, and grace duration remain launch decisions. Verification keys are pinned by the public core, support overlap during rotation, and never come from the downloaded artifact being verified.

## Release catalog and artifact contract

The signed catalog selects an artifact by bundle ID, channel, core compatibility, plugin-host API compatibility, platform, and architecture. Each release describes at least:

```json
{
  "schemaVersion": 1,
  "id": "agentmemory.pro",
  "version": "1.0.0",
  "channel": "stable",
  "core": ">=0.5.0 <1.0.0",
  "pluginApi": 1,
  "platform": "any",
  "architecture": "any",
  "sha256": "hex-encoded archive digest",
  "size": 123456,
  "entrypoint": "bundle/index.js",
  "plugins": ["agentmemory.session-intelligence", "agentmemory.web-console"]
}
```

The archive contains compiled commercial code, plugin manifests, contributed skills, commercial license text, preserved public-core notices, and third-party notices. It must not depend on npm lifecycle scripts, download dependencies during activation, or include real credentials. Archive paths, symlinks, expanded size, file count, and permissions are validated before extraction.

## Transactional installation

The machine-wide user installation is independent of `AGENT_MEMORY_DIR`, which selects a memory store. The default install root is `~/.agent-memory/system/plugins`; the dedicated non-secret `AGENT_MEMORY_PLUGIN_DIR` setting may override it for managed deployment and tests.

An install or upgrade must:

1. acquire a bounded installation lock;
2. inspect the current receipt without executing plugin code;
3. authenticate and resolve a compatible signed catalog entry;
4. download to a newly created staging directory;
5. verify catalog signature, artifact digest, archive limits, manifest, and compatibility;
6. extract without path traversal or link traversal;
7. load only the declared entry point for a bounded health check;
8. atomically switch the active-version receipt;
9. install declared skills and hooks only after successful activation;
10. preserve the previous known-good version for rollback and remove abandoned staging data.

Failure before activation leaves the previous version active. Failure immediately after activation restores the previous receipt. Concurrent installers do not interleave. The core never invokes package-manager lifecycle scripts or elevates privileges.

Uninstall removes executable versions, the active receipt, contributed skills, and managed hooks. It does not remove `MEMORY.md`, daily logs, topics, scratchpad items, source session logs, plugin-created review data, or billing state. A separate future purge command would require explicit scope and confirmation.

## Plugin host API v1

The implementation will expose equivalent TypeScript types from the public package. This document is authoritative until those types ship:

```ts
export interface AgentMemoryPluginBundleV1 {
	apiVersion: 1;
	manifest: AgentMemoryBundleManifestV1;
	plugins: readonly AgentMemoryPluginV1[];
}

export interface AgentMemoryPluginV1 {
	manifest: AgentMemoryPluginManifestV1;
	activate(host: AgentMemoryPluginHostV1): Promise<void>;
	healthCheck(host: AgentMemoryPluginHostV1): Promise<{ ok: boolean; message?: string }>;
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
```

The final exported contract must define the referenced request, result, command, hook, manifest, entitlement-status, permission, cancellation, and structured-error types. Commercial manifests are plan-neutral: they declare `entitlement: "commercial"`, their provided capabilities, and the `requiredCapability` for each guarded command or hook. The loader validates every bundled plugin first, then creates a host instance scoped to that plugin's manifest. Host methods enforce its declared permissions. Plugins receive only derived entitlement state, capability grants, quota policy, and time bounds through host APIs, never raw signed claims or commercial credentials.

Installed bundles are trusted, signed first-party JavaScript loaded into the AgentMemory process. Manifest permissions constrain host APIs; they are not an operating-system sandbox and do not remove the bundle's ambient Node.js process or filesystem authority. This contract does not approve arbitrary third-party plugin loading. State-directory isolation prevents accidental host-API crossover, not malicious code running in the same process.

Activation order is: verify artifact, verify entitlement, validate every manifest, resolve required dependencies, create permission-scoped host adapters, activate plugins, then register commands and hooks. Registered-but-unavailable dependencies do not satisfy `requires`.

## Runtime entitlement behavior

The core reloads local entitlement state before every commercial command or compatibility alias and checks its exact required capability before dispatch. Plugin-owned hooks, worker starts, Web Console launches, and commercial API routes must perform the same check through `host.getEntitlement()`. A long-running plugin process must recheck through that host API at a bounded interval and respond safely to expiration or capability removal. Browser-session authorization remains separate from commercial entitlement and never contains subscription credentials.

When entitlement is in grace, paid capabilities continue locally and status explains when grace ends. When expired or invalid, new paid work fails closed with a renewal action; core memory remains available and no user data is deleted.

## Compatibility and updates

- Core and bundle versions follow semantic versioning.
- The integer plugin-host API changes only for incompatible host-contract revisions.
- A bundle declares both a core range and a host API version.
- `plugin install` and `plugin update` choose the newest compatible release in the selected channel, not merely the newest release.
- Updates occur only after an explicit install/update command or a future separately approved policy. No background auto-download is part of v1.
- A newer incompatible release is reported without replacing the current working version.

## Security and release gates

Before launch, automated tests must demonstrate:

- public `myagentmemory` package contents contain no paid code, SPA assets, private source maps, commercial credentials, or private release configuration;
- missing, active, grace, expired, malformed, wrong-audience, and wrong-signature entitlements fail as specified;
- absent, current, outdated, interrupted, corrupt, incompatible, and concurrent installation paths are deterministic and recoverable;
- archive traversal, symlink traversal, oversized archives, digest mismatch, unknown signing keys, and unauthorized commands fail closed;
- all paid entry points enforce entitlement while every core memory operation remains available;
- `--json` remains parseable and secret-free and non-interactive use never opens a browser;
- install, update, rollback, and uninstall work on supported macOS, Linux, and Windows environments.

## Deferred work

This contract does not approve:

- arbitrary third-party plugin loading or a public marketplace;
- remote execution of plugin code;
- silent or package-postinstall browser prompts;
- background commercial telemetry or transmission of memory data;
- pricing, seat counts, device limits, or a billing vendor;
- Enterprise readiness claims before SSO, policy, retention, audit, DLP, and managed deployment are implemented and tested.
