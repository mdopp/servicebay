/**
 * Server-side install runner.
 *
 * Owns the deploy loop that used to live in `useStackInstall.runInstall`
 * (browser). Moving it server-side fixes the long-standing failure mode
 * where closing the browser tab during install left the wizard stuck:
 * the in-flight `/api/services?stream=1` request would complete on the
 * server but the *next* template in the loop was never started, because
 * the loop itself ran in the browser.
 *
 * Lifecycle:
 *
 *   /api/install/start  → createJob() + startJob() (this file)
 *                              ↓
 *                       runs detached, persists progress to jobStore,
 *                       emits live updates via socketBridge
 *                              ↓
 *   client subscribes via socket events; reattaches via
 *   GET /api/install/status when a tab opens mid-flow.
 *
 * Cross-cutting state (abort flags, NPM-credentials pause promises) is
 * kept in module-level Maps keyed by jobId. These don't survive a server
 * restart by design: any job in an active phase at startup is flipped to
 * `crashed` by `jobStore.markCrashedOnStartup()` (see server.ts).
 */
import crypto from 'node:crypto';
import { renderTemplate } from '../template/render';
// Direct lib imports (#600) — the actions.ts wrappers are RPC bridges
// for client components, not appropriate for server-side lib code.
import {
  getTemplatePostDeployScript,
  getTemplateMigrationScripts,
  getTemplateYaml,
  syncRegistries,
} from '@/lib/registry';
import { parseTemplateSchemaVersion } from '@/lib/templateSchemaVersion';
import { parseTemplateManifest } from '@/lib/template/contract';
import { topoSortByDependencies, resolveAlreadyInstalled } from '@/lib/stackInstall/dependencies';
import { PullTracker, describePull } from './pullProgress';
import { parseTemplateTier } from '@/lib/templateTier';
import { selectMigrationChain } from '@/lib/stackInstall/migrations';
import {
  bootstrapNpmAdmin,
  type StackVariable,
} from '@/lib/stackInstall/postInstall';
import { buildCredentialsManifest, mergeCredentials, type Credential } from '@/lib/stackInstall/credentialsManifest';
import { provisionPortalWithRetries } from '@/lib/stackInstall/portalProvision';
import { npmAdminCredStatus, rekeyNpmAdmin } from '@/lib/reverseProxy/npmAdminRekey';
import { getCapabilityBus } from '@/lib/capabilities/bus';
import { getStoreSnapshot } from '@/lib/store/repository';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { getConfig, saveConfig, type InstalledCredential } from '@/lib/config';
import { reconcileLanIp } from '@/lib/lanIp';
import {
  appendLog,
  getJob,
  updateJob,
  type JobInput,
  type JobInputItem,
  type JobState,
} from './jobStore';
import { emitJobLog, emitJobUpdate } from './socketBridge';
import {
  clearPendingCredentials,
  provideCredentials,
  skipCredentials,
  waitForCredentials as waitForCredentialsResolve,
} from './credentialResolver';
import {
  ensureProxyHosts,
  ensureOidcClients,
  ensureHermesApiKey,
} from './postInstallDispatcher';

// Re-export the surface previously exposed from this module so the
// install route handlers + tests don't have to learn the new file
// names. The extractions in #975 are structural, not API changes.
export { provideCredentials, skipCredentials, ensureProxyHosts, ensureOidcClients };

const MAX_DEPLOY_ATTEMPTS = 3;
const DEPLOY_BACKOFF_MS = [0, 1000, 4000];

/** Cross-template settle-wait: poll the digital twin until every newly
 *  deployed service reports active. Cap at 3 minutes — long enough for
 *  cold-start image pulls on a normal connection — then transition either
 *  way and let the diagnose probe report what's genuinely stuck. */
const SETTLE_TIMEOUT_MS = 3 * 60_000;
const SETTLE_POLL_MS = 5_000;
const SETTLE_HEARTBEAT_MS = 15_000;

/** Inter-template dependency-readiness gate (#810). The topo-sort
 *  guarantees a template deploys *after* its `servicebay.dependencies`,
 *  but ordering is not readiness — the deploy loop fires each template's
 *  post-deploy script back-to-back, so a script that talks to a
 *  dependency's API (e.g. `media` post-deploy → Authelia OIDC discovery)
 *  can run while that dependency is still booting. Before deploying an
 *  item we block until every declared dependency reports health-ready in
 *  the twin. Same 3-minute cap as the settle-wait — long enough for a
 *  cold-start image pull, then proceed and let diagnose surface a real
 *  failure rather than hanging the install forever. */
const DEP_READY_TIMEOUT_MS = 3 * 60_000;
const DEP_READY_POLL_MS = 3_000;

/** Set by `abortJob`. Checked at top of every deploy-loop iteration and
 *  before each retry attempt so the loop bails out as soon as possible. */
const abortFlags = new Map<string, boolean>();

/** Loopback fetch helper. proxy.ts middleware gates state-changing API
 *  calls on either a session cookie OR the X-SB-Internal-Token header
 *  (the same token the post-deploy scripts on the agent host use). The
 *  runner has no session, so we attach the token here — without it
 *  every POST /api/services / NPM / portal call from this process gets
 *  403'd by the CSRF check (no Origin header from Node fetch). */
/** Render a byte count as a short user-readable string ("1.2 GB",
 *  "240 MB"). Used by the image-pull progress lines (#805). Powers
 *  of 1024 because that's how podman reports image sizes. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function apiFetch(p: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers });
}

/**
 * Persist a log line to the job's log file AND broadcast it over the
 * Socket.IO server so any open client renders it immediately. The two
 * layers are deliberate: socket pushes are best-effort (a client that
 * just connected won't see lines emitted before its subscription), the
 * log file is the source of truth on reattach.
 */
async function log(jobId: string, line: string): Promise<void> {
  await appendLog(jobId, line);
  emitJobLog(jobId, line);
}

async function patchJob(
  jobId: string,
  partial: Parameters<typeof updateJob>[1],
): Promise<JobState | null> {
  const next = await updateJob(jobId, partial);
  if (next) emitJobUpdate(next);
  return next;
}

/** Public abort entry-point. Sets the in-memory flag and unblocks any
 *  pending credential prompt. The deploy loop discovers the flag on
 *  the next iteration and exits cleanly. */
export function abortJob(jobId: string): void {
  abortFlags.set(jobId, true);
  clearPendingCredentials(jobId);
}

/** Pause the deploy loop until the operator submits NPM credentials or
 *  skips the prompt. Sets the `needs_credentials` phase + fallback on
 *  the job, then awaits the resolve via credentialResolver. Also
 *  unblocks on `abortJob` (which calls `clearPendingCredentials`). */
async function waitForCredentials(
  jobId: string,
  fallback: { email: string; password: string },
): Promise<{ email: string; password: string } | null> {
  await patchJob(jobId, {
    phase: 'needs_credentials',
    needsCredentials: { fallback },
  });
  return waitForCredentialsResolve(jobId);
}

/** Extract every unique container `image:` reference from items the
 *  install runner is about to deploy. Filters out already-installed
 *  items (their images are warm by definition) and items without yaml.
 *
 *  Uses a tolerant regex (the value after `image:` up to whitespace or
 *  `#`) rather than a YAML parse — templates carry Mustache placeholders
 *  in unrelated fields that can break js-yaml. Images themselves are
 *  static refs in every shipped template, so the regex is reliable here.
 */
export function collectImagesToPull(
  items: ReadonlyArray<{ name: string; yaml?: string; alreadyInstalled?: boolean }>,
  view?: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const imageRe = /^[\t ]*-?[\t ]*image:[\t ]*['"]?([^\s'"#]+)['"]?[\t ]*(?:#.*)?$/gm;
  for (const item of items) {
    if (item.alreadyInstalled || !item.yaml) continue;
    for (const m of item.yaml.matchAll(imageRe)) {
      let image = m[1].trim();
      if (!image) continue;
      // Templates may interpolate the image tag via Mustache
      // (e.g. `image: {{GATEKEEPER_IMAGE}}`). The pre-pull step ran
      // BEFORE per-item Mustache rendering, so the literal placeholder
      // hit `agent.pullImage()` and surfaced as
      //   "(note) pre-pull failed for {{GATEKEEPER_IMAGE}}: parsing
      //   reference … invalid reference format"
      // in the install log. Render now when a view is provided. If
      // the rendered string STILL contains an unresolved `{{...}}`
      // (no value for that variable), skip the pre-pull for that
      // image — the deploy-step's sequential pull will handle it
      // with the proper render context. #1170.
      if (view) {
        image = renderTemplate(image, view);
        // Mustache expands missing vars to '' rather than leaving the
        // literal `{{...}}` in place, so check both shapes — empty or
        // still-templated → skip and let the deploy step handle it.
        if (!image || image.includes('{{')) continue;
      }
      seen.add(image);
    }
  }
  return [...seen];
}

/** True when `name` reports ready in the twin's service list. Prefers
 *  the unified health signal (#627) — set by the service-health poller
 *  when the template ships a `servicebay.healthcheck` annotation — and
 *  falls back to the systemd-active flag for templates that don't ship
 *  one yet. `degraded: true` still counts as ready (the operator sees
 *  the soft-fail banner; gating doesn't hang on it). */
export function isServiceReady(
  services: ReadonlyArray<{ name: string; active?: boolean; health?: { ready: boolean } }>,
  name: string,
): boolean {
  return services.some(s => {
    if (s.name !== name && s.name !== `${name}.service`) return false;
    if (s.health) return s.health.ready === true;
    return s.active === true;
  });
}

/**
 * Install-time template variables ServiceBay injects on top of the
 * operator-supplied ones, keyed by template.
 *
 * `auth`: always force LLDAP to re-key its admin bind to *this install's*
 * `LLDAP_ADMIN_PASSWORD` via `LLDAP_FORCE_LDAP_USER_PASS_RESET=always`.
 * LLDAP seeds the admin password from env only on first DB init; on a
 * reinstall over a preserved `users.db` the DB keeps its old admin
 * password while Authelia binds with the new one → "Invalid Credentials"
 * (LDAP code 49) and an endless Authelia crash loop.
 *
 * `always` (NOT `true`, which one-shot resets then *exits* demanding a
 * restart without the flag — fatal with the flag baked permanently into
 * the pod env) re-syncs the admin password on every start AND keeps
 * serving. It only re-keys the admin account; LLDAP user accounts are
 * preserved.
 *
 * This is deliberately NOT gated on "was the secret freshly generated?".
 * The old heuristic (`isRegenerated ? 'always' : 'false'`) assumed a
 * reused/saved `LLDAP_ADMIN_PASSWORD` already matched a preserved
 * `users.db` — but once the saved secret and the DB diverge across
 * repeated reinstalls, the reused path never re-syncs and the bind fails
 * forever. Forcing `always` on every auth deploy closes that gap
 * idempotently (#666 / ARCH-15; the credential-reconciliation
 * "auto-rekey when safe" path for LLDAP).
 */
export function authDynamicVars(itemName: string): Record<string, string> {
  if (itemName === 'auth') {
    return { LLDAP_FORCE_LDAP_USER_PASS_RESET: 'always' };
  }
  return {};
}

/** Settle-wait: poll the digital twin in-process until every newly
 *  deployed service is ready.
 *
 *  Readiness preference order (#627):
 *    1. `twin.services[].health.ready === true` — set by the service-health
 *       poller (#626) when the template ships a `servicebay.healthcheck`
 *       annotation. This is the canonical signal Phase 3 migrates everyone
 *       onto.
 *    2. `twin.services[].active === true` — legacy systemd-state-only
 *       fallback for templates without a healthcheck annotation yet.
 *       Phase 3C removes this once every template has migrated.
 *
 *  Either signal counts. The browser version of this used to receive twin
 *  snapshots over Socket.IO; server-side we read the singleton directly,
 *  which is both simpler and authoritative. */
async function settleWait(
  jobId: string,
  deployed: { name: string }[],
  node: string,
): Promise<void> {
  if (deployed.length === 0) return;
  const expected = deployed.map(i => i.name);
  const startedAt = Date.now();
  let lastReady = -1;
  let lastLogAt = Date.now();
  while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
    if (abortFlags.get(jobId)) return;
    const snapshot = getStoreSnapshot();
    const twinNode = snapshot.nodes?.[node];
    const services = twinNode?.services ?? [];
    const ready = expected.filter(name => isServiceReady(services, name)).length;
    const now = Date.now();
    if (ready !== lastReady) {
      await log(jobId, `Waiting for services to become active... (${ready}/${expected.length} up)`);
      lastReady = ready;
      lastLogAt = now;
    } else if (now - lastLogAt >= SETTLE_HEARTBEAT_MS) {
      const elapsed = Math.floor((now - startedAt) / 1000);
      await log(jobId, `Still waiting... (${ready}/${expected.length} up, ${elapsed}s elapsed)`);
      lastLogAt = now;
    }
    if (ready === expected.length) break;
    await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
  }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (lastReady === expected.length) {
    await log(jobId, `✅ All ${expected.length} services active after ${elapsed}s.`);
  } else {
    await log(jobId, `⚠️ ${lastReady}/${expected.length} services active after ${elapsed}s — slow image pulls or a real failure. Self-diagnose below will tell you which.`);
  }
}

/** Block until every declared dependency of `item` reports health-ready
 *  in the twin (#810). Called before the item deploys — its post-deploy
 *  script runs as part of the same `/api/services` POST, so the
 *  dependency must be responsive *before* the deploy fires, not just
 *  ordered ahead of it.
 *
 *  Best-effort by design: on timeout we log a warning and proceed. The
 *  post-deploy may then report errors, but those surface through the
 *  normal diagnose path — far better than wedging the whole install on
 *  one slow dependency. `bootstrapServiceHealth` is invoked first so the
 *  poller is already probing every just-deployed dependency; without
 *  that the gate would only ever see the coarse systemd-active flag. */
export async function waitForDependencies(
  jobId: string,
  item: { name: string; dependencies?: string[] },
  node: string,
): Promise<void> {
  const deps = item.dependencies ?? [];
  if (deps.length === 0) return;

  // Register every deployed-so-far service with the health poller so the
  // dependencies we're about to wait on have a live `health` signal.
  try {
    const { bootstrapServiceHealth } = await import('@/lib/health/serviceHealthBootstrap');
    await bootstrapServiceHealth(node);
  } catch { /* fall back to the systemd-active signal */ }

  const startedAt = Date.now();
  let lastLogAt = startedAt;
  const pending = new Set(deps);
  await log(jobId, `Waiting for ${item.name}'s dependencies to become healthy: ${deps.join(', ')}...`);
  while (pending.size > 0 && Date.now() - startedAt < DEP_READY_TIMEOUT_MS) {
    if (abortFlags.get(jobId)) return;
    const services = getStoreSnapshot().nodes?.[node]?.services ?? [];
    for (const dep of [...pending]) {
      if (isServiceReady(services, dep)) pending.delete(dep);
    }
    if (pending.size === 0) break;
    const now = Date.now();
    if (now - lastLogAt >= SETTLE_HEARTBEAT_MS) {
      const elapsed = Math.floor((now - startedAt) / 1000);
      await log(jobId, `Still waiting for ${[...pending].join(', ')} to be healthy (${elapsed}s elapsed)...`);
      lastLogAt = now;
    }
    await new Promise(r => setTimeout(r, DEP_READY_POLL_MS));
  }
  if (pending.size === 0) {
    await log(jobId, `✅ ${item.name}'s dependencies are healthy.`);
  } else {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    await log(jobId, `⚠️ ${item.name}'s dependencies not healthy after ${elapsed}s (${[...pending].join(', ')}). Continuing anyway — its post-deploy may report errors; self-diagnose below will tell you what's stuck.`);
  }
}

interface DeployContext {
  jobId: string;
  input: JobInput;
  scriptCredentials: Credential[];
  deployed: { name: string }[];
  reusedSecretNames: Set<string>;
}

/**
 * #1318 — find direct `{{VAR}}` interpolations in a pod template that would
 * render empty against `view`. Mustache turns an unfilled var into '', which
 * silently deploys a broken pod (empty image tag / env / mount) with no
 * breadcrumb. Section refs (`{{#VAR}}` / `{{^VAR}}` / `{{/VAR}}`) are
 * conditionals that are legitimately empty (e.g. `{{#ZWAVE_DEVICE}}`), so a
 * var used in a section is treated as optional and excluded; only *direct*
 * interpolations are considered. The caller warns (does not hard-fail) — some
 * direct refs are legitimately optional (an SSH key OR a password) and the
 * variable schema carries no `required` flag to tell them apart.
 */
export function findEmptyYamlVars(yaml: string, view: Record<string, string>): string[] {
  const sectionVars = new Set<string>();
  for (const m of yaml.matchAll(/\{\{\s*[#^/]\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g)) sectionVars.add(m[1]);
  const directRefs = new Set<string>();
  for (const m of yaml.matchAll(/\{\{\{?\s*([A-Z_][A-Z0-9_]*)\s*\}{2,3}/g)) directRefs.add(m[1]);
  return [...directRefs].filter(r => !sectionVars.has(r) && (!(r in view) || view[r] === ''));
}

/**
 * #1724 — before the auth stack overwrites Authelia's `configuration.yml`,
 * merge any OIDC clients already on disk that the fresh render doesn't own
 * back into the file-to-be-written. Without this, redeploying `auth` wipes
 * every other stack's incrementally-registered SSO client.
 *
 * Mutates the matching `extraFiles` entry in place. Best-effort: any failure
 * to read the existing config leaves the fresh render untouched (the
 * post-deploy `ensureOidcClients` reconcile is the backstop) — never throws.
 */
export async function preserveAutheliaOidcClients(
  jobId: string,
  node: string | undefined,
  extraFiles: { path: string; content: string }[],
): Promise<void> {
  // Authelia's config is the only `configuration.yml` the auth stack writes.
  const cf = extraFiles.find(f => f.path.endsWith('/configuration.yml') || f.path.endsWith('configuration.yml'));
  if (!cf) return;

  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(node || 'Local');
    const readRes = await agent.sendCommand('read_file', { path: cf.path }).catch(() => null);
    const existing = readRes ? (readRes.content || readRes.stdout || '') : '';
    if (!existing) return; // fresh install — nothing on disk to preserve

    const { mergeAutheliaOidcClients } = await import('@/lib/capabilities/autheliaClientMerge');
    const merged = mergeAutheliaOidcClients(cf.content, existing);
    if (merged !== cf.content) {
      cf.content = merged;
      await log(jobId, 'ℹ️ Preserved existing Authelia OIDC client registrations across the auth redeploy (#1724).');
    }
  } catch (e) {
    await log(jobId, `⚠️ Could not preserve existing Authelia OIDC clients (${e instanceof Error ? e.message : String(e)}); the post-deploy reconcile will re-register this install's clients.`);
  }
}

/** Deploy a single template via /api/services?stream=1. Returns true on
 *  successful deploy, false on terminal failure. Retries transient
 *  failures up to MAX_DEPLOY_ATTEMPTS. */
async function deployItem(ctx: DeployContext, item: JobInputItem): Promise<boolean> {
  const { jobId, input } = ctx;
  if (!item.yaml) return false;

  await log(jobId, `Installing ${item.name}...`);
  await patchJob(jobId, {
    progress: {
      currentItem: item.name,
      deployedNames: ctx.deployed.map(d => d.name),
      totalCount: input.items.filter(i => i.checked).length,
    },
  });

  // #1585 — per-service wipe under the new wipeMode model. wipe-config clears
  // only this service's CONFIG paths (keeps DATA); wipe-all clears CONFIG+DATA.
  // Acts ONLY on this service's data dir — never a system-wide nuke. No-op for
  // `install` (or absent mode). Best-effort; never throws.
  // The service plus any sibling-store services that ride its deploy (#1594 —
  // e.g. home-assistant carries `home-assistant-zwave`, the zwave-js key store
  // in a sibling dir with no template name of its own).
  const { getSiblingBackupServices } = await import('@/lib/externalBackup/serviceManifest');
  const backupServices = [item.name, ...getSiblingBackupServices(item.name)];

  {
    const { wipeServiceForReinstall } = await import('@/lib/externalBackup/restore');
    for (const svc of backupServices) {
      await wipeServiceForReinstall(
        svc,
        { wipeMode: input.wipeMode, node: input.node },
        line => log(jobId, line),
      );
    }
  }

  // #1218 entry point 1 — restore this service's config from the NAS before its
  // pod starts. On `install` it restores only into an empty data dir (config
  // missing); on `wipe-config`/`wipe-all` the CONFIG paths were just cleared, so
  // it force-restores them over the kept DATA. No-op otherwise; never throws
  // (see autoRestoreServiceOnReinstall). Mirrors the cert-archive restore.
  {
    const { autoRestoreServiceOnReinstall } = await import('@/lib/externalBackup/restore');
    for (const svc of backupServices) {
      await autoRestoreServiceOnReinstall(
        svc,
        { wipeMode: input.wipeMode, node: input.node },
        line => log(jobId, line),
      );
    }
  }

  const view = (input.variables as StackVariable[]).reduce<Record<string, string>>((acc, v) => {
    acc[v.name] = v.value;
    return acc;
  }, {});

  // Inject dynamic variables for self-healing and template rendering.
  Object.assign(view, authDynamicVars(item.name));
  // Render YAML with unified template renderer
  const yamlContent = renderTemplate(item.yaml, view);

  // #1318 — the pod YAML had no missing-var guard (config files did), so an
  // unfilled {{VAR}} rendered empty and deployed silently. Surface a
  // breadcrumb for any direct ref that rendered empty so a crash-looping pod
  // traces back to the unfilled variable. Warn rather than hard-fail: some
  // direct refs are legitimately optional and there is no required flag.
  const emptyYamlVars = findEmptyYamlVars(item.yaml, view);
  if (emptyYamlVars.length > 0) {
    await log(jobId, `⚠️ ${item.name}: pod template variable(s) rendered empty: ${emptyYamlVars.join(', ')}. ` +
      `If any are required, go back to Configure and fill them in (or check the template's variables.json defaults) — an empty value can crash-loop the pod.`);
  }

  const kubeContent =
    `[Kube]\nYaml=${item.name}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

  // Sanity-check that every {{VAR}} in a config file has a value. Without
  // this, Mustache renders missing vars as empty strings — silent data
  // loss that produces crash-looping pods with no breadcrumb.
  const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
  for (const cf of (item.configFiles || [])) {
    if (!cf.targetPath) continue;
    // Asset files (#1156) ship content verbatim, so {{…}} in the body
    // isn't a placeholder reference — skip the missing-var sanity check
    // for them.
    if (cf.renderContent === false) continue;
    const refs = new Set<string>();
    for (const m of cf.content.matchAll(refRe)) refs.add(m[1]);
    const missing = [...refs].filter(r => !(r in view) || view[r] === '');
    if (missing.length > 0) {
      const msg = `Cannot deploy ${item.name}: ${cf.filename} references variable(s) with no value: ${missing.join(', ')}. ` +
        `Go back to the Configure step and fill them in (or check the template's variables.json defaults).`;
      await log(jobId, `❌ ${msg}`);
      throw new Error(msg);
    }
  }

  const extraFiles = (item.configFiles || [])
    .filter(cf => cf.targetPath)
    .map(cf => ({
      path: renderTemplate(cf.targetPath!, view),
      // Asset files (#1156) opt out of content rendering — SKILL.md
      // bodies may contain `{{...}}` literals as documentation that
      // Mustache would otherwise corrupt. Default-true preserves the
      // existing `.mustache` behaviour for config files.
      content: cf.renderContent === false ? cf.content : renderTemplate(cf.content, view),
    }));

  // #1724 — the auth template's `configuration.yml.mustache` only ships its own
  // baked-in `servicebay` OIDC client. Other SSO stacks register their clients
  // incrementally into the on-disk config; a fresh render would OVERWRITE and
  // DROP them, breaking every other service's SSO with `invalid_client` until
  // each stack is individually redeployed. Before writing the auth config, read
  // the current on-disk `configuration.yml` and merge back any clients the
  // fresh render doesn't own — preserving each client's secret (no rotation).
  await preserveAutheliaOidcClients(jobId, input.node, extraFiles);

  // Optional per-template post-deploy.py — server runs it after the unit
  // starts; output streams back via `progress` events. Parsed below for
  // `__SB_CREDENTIAL__ {json}` markers.
  let postDeployScript: string | undefined;
  try {
    const raw = await getTemplatePostDeployScript(item.name, input.templateSource);
    if (raw) postDeployScript = renderTemplate(raw, view);
  } catch { /* template ships no script — fine */ }

  // Migration chain — discover via upgrade-preview, render any selected
  // steps with Mustache. Best-effort: a fetch failure here shouldn't
  // block the deploy — if migrations are actually needed and we skipped
  // them, the new container will fail to start and diagnose will surface it.
  let migrations: { filename: string; fromVersion: number; toVersion: number; content: string }[] | undefined;
  try {
    const targetVersion = parseTemplateSchemaVersion(item.yaml);
    const previewUrl = `/api/system/templates/${encodeURIComponent(item.name)}/upgrade-preview`
      + (input.templateSource && input.templateSource !== 'Built-in' ? `?source=${encodeURIComponent(input.templateSource)}` : '');
    const previewRes = await apiFetch(previewUrl);
    if (previewRes.ok) {
      const preview = await previewRes.json();
      const installedVersion = typeof preview.installedVersion === 'number' ? preview.installedVersion : null;
      if (installedVersion !== null && installedVersion < targetVersion) {
        const scripts = await getTemplateMigrationScripts(item.name, input.templateSource);
        const result = selectMigrationChain(installedVersion, targetVersion, scripts);
        if (!result.ok) {
          const msg = result.reason === 'missing-step'
            ? `Migration chain for ${item.name} is incomplete: no script for v${result.from}→v${result.expectedNext} (have ${result.available.length === 0 ? 'none' : result.available.map(v => `v${v}`).join(', ')}). Aborting deploy.`
            : `Migration chain for ${item.name} has overlapping/invalid steps (${result.conflicts.map(c => `v${c.fromVersion}→v${c.toVersion}`).join(', ')}). Aborting deploy.`;
          await log(jobId, `❌ ${msg}`);
          throw new Error(msg);
        }
        if (result.chain.length > 0) {
          migrations = result.chain.map(s => ({
            filename: s.filename,
            fromVersion: s.fromVersion,
            toVersion: s.toVersion,
            content: renderTemplate(s.content, view),
          }));
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Migration chain for')) throw e;
    await log(jobId, `⚠️ ${item.name}: could not check migration chain (${e instanceof Error ? e.message : String(e)}). Continuing without migrations.`);
  }

  const postDeployEnv: Record<string, string> = {};
  for (const v of input.variables) {
    if (typeof v.value === 'string') postDeployEnv[v.name] = v.value;
  }
  postDeployEnv.HOST = input.host || 'localhost';

  // LAN_IP + OPERATOR_EMAIL — server-side context that every template
  // can rely on without each having to wire it through variables.json.
  //
  //   LAN_IP: the address rootless podman actually port-forwards to.
  //   With `hostNetwork: true` on a rootless pod, ports inside the
  //   container's namespace (e.g. immich-server binding [::1]:2283)
  //   are not always visible on the host's main loopback; podman
  //   publishes them on the LAN IP via the userspace forwarder.
  //   Templates that HTTP-probe their own service from the host
  //   post-deploy shell can fall back to this.
  //
  //   OPERATOR_EMAIL: the single email address ServiceBay already
  //   collects for outbound notifications, used as the canonical
  //   "the operator" identity. Templates seeding admin accounts
  //   (immich, audiobookshelf, navidrome…) use it as a fallback when
  //   their per-template <SERVICE>_ADMIN_EMAIL variable is blank, so
  //   the operator only ever has to type their email once. SSO auto-
  //   linking by email also flows through this.
  //
  // Both are best-effort; a missing config field just leaves the env
  // var unset and templates fall back to their own defaults.
  try {
    const config = await getConfig();
    const lanIp = config.reverseProxy?.lanIp;
    if (lanIp) postDeployEnv.LAN_IP = lanIp;
    const operatorEmail = config.notifications?.email?.to?.[0]?.trim();
    if (operatorEmail) postDeployEnv.OPERATOR_EMAIL = operatorEmail;
  } catch { /* leave env unset; templates handle missing values */ }

  const attemptDeploy = async (): Promise<void> => {
    const query = input.node ? `?node=${input.node}&stream=1` : '?stream=1';
    let res: Response;
    try {
      res = await apiFetch(`/api/services${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name,
          kubeContent,
          yamlContent,
          yamlFileName: `${item.name}.yml`,
          extraFiles,
          postDeployScript,
          postDeployEnv: postDeployScript || (migrations && migrations.length > 0) ? postDeployEnv : undefined,
          migrations,
        }),
      });
    } catch (networkErr) {
      throw new Error(`network: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody.error || `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        const fatal = new Error(msg);
        (fatal as Error & { fatal?: boolean }).fatal = true;
        throw fatal;
      }
      throw new Error(msg);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'progress') {
            if (typeof evt.message === 'string' && evt.message.startsWith('__SB_CREDENTIAL__ ')) {
              try {
                const captured = JSON.parse(evt.message.slice('__SB_CREDENTIAL__ '.length));
                // Tag with the owning template so the Saved-credentials UI can
                // resolve the loopback `url` to the service's public subdomain
                // (#1626) and per-template uninstall can drop it (#631). The
                // marker itself doesn't carry the name; the deploy loop does.
                if (captured && typeof captured === 'object' && captured.template == null) {
                  captured.template = item.name;
                }
                ctx.scriptCredentials.push(captured);
              } catch { /* malformed marker — drop it */ }
              continue;
            }
            await log(jobId, evt.message);
          } else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message !== line.trim()) throw parseErr;
        }
      }
    }
  };

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_DEPLOY_ATTEMPTS; attempt++) {
    if (abortFlags.get(jobId)) return false;
    if (DEPLOY_BACKOFF_MS[attempt - 1] > 0) {
      await new Promise(r => setTimeout(r, DEPLOY_BACKOFF_MS[attempt - 1]));
    }
    try {
      await attemptDeploy();
      await log(jobId, attempt > 1
        ? `✅ ${item.name} deployed on attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS}.`
        : `✅ ${item.name} deployed (containers may still be starting in background).`);
      return true;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if ((lastErr as Error & { fatal?: boolean }).fatal) break;
      if (attempt < MAX_DEPLOY_ATTEMPTS) {
        await log(jobId, `⏳ ${item.name} attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS} failed (${lastErr.message}); retrying in ${DEPLOY_BACKOFF_MS[attempt] / 1000}s…`);
      }
    }
  }
  const tail = (lastErr as Error & { fatal?: boolean })?.fatal
    ? lastErr?.message ?? 'unknown error'
    : `after ${MAX_DEPLOY_ATTEMPTS} attempt(s): ${lastErr?.message ?? 'unknown error'}`;
  await log(jobId, `❌ Failed to install ${item.name} ${tail}`);
  return false;
}

// Consolidated per-service proxy-host provisioning (#807) and the
// Authelia OIDC client reconciliation (#989) moved to
// `./postInstallDispatcher.ts` in #975 — they're re-exported at the
// top of this file so the install pipeline + tests don't need to
// learn the new path.

/** Inner async pipeline — wrapped by `startJob` so the public surface
 *  can stay synchronous (kicks off the work, returns immediately). */
async function runJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const input = job.input;

  // Reset abort flag for this run.
  abortFlags.delete(jobId);

  const scriptCredentials: Credential[] = [];

  // #1585 — the install runner NEVER system-wide-wipes. The old
  // `if (input.cleanInstall && cleanInstallConfirm === 'RESET')` branch POSTed
  // to `/api/system/stacks/reset` (a system-wide nuke of EVERY service on the
  // node) and was already dead (cleanInstall was hard-pinned `false` in the
  // start route). It is deleted here. System-wide wipe lives only in the
  // explicit Factory Reset (`/api/system/factory-reset`, which still uses
  // `/api/system/stacks/reset`). Per-service wipe under the new `wipeMode`
  // model happens per-service in `deployItem` (it clears only that service's
  // CONFIG (wipe-config) or CONFIG+DATA (wipe-all) paths, never other
  // services' data), then restores CONFIG from the NAS on startup.

  // Capture / refresh the host's LAN IP synchronously (#660 — S2).
  //
  // Was previously a 60s boot-deferred setTimeout in server.ts that could
  // race: when the timer fired before the agent was up, or before
  // `secret.key` was rewritten on a wipe, `lanIp` never landed in config —
  // and ~6 diagnose probes (router-DNS, AdGuard rewrites, NPM bootstrap,
  // OIDC, TLS certs, LE requests) degraded to "no install-time value
  // recorded yet" with no clear recovery path.
  //
  // Doing it here, in the runner that already has the agent under
  // contract, makes the capture deterministic: every install (clean or
  // not) writes the current outbound LAN IP before the deploy loop fires.
  // The boot-timer in server.ts is now a drift-detection safety net for
  // installs that pre-date this change; both call the same idempotent
  // `reconcileLanIp` (no-op when value matches, history append on drift).
  try {
    const node = input.node || 'Local';
    const ip = await reconcileLanIp(node);
    if (ip) {
      await log(jobId, `Captured LAN IP: ${ip}`);
      // Expose LAN_IP to template rendering (#817). Templates that drop
      // `hostNetwork` need it for a `hostAliases` entry that resolves
      // the public auth subdomain to the LAN. `LAN_IP` is declared as a
      // global in templates/settings.json (blank default); the wizard
      // can't know the host IP, so the runner fills it in here — every
      // `{{LAN_IP}}` in a rendered template.yml resolves to this value.
      const lanVar = input.variables.find(v => v.name === 'LAN_IP');
      if (lanVar) lanVar.value = ip;
      else input.variables.push({ name: 'LAN_IP', value: ip, global: true });
    } else {
      await log(jobId, '⚠️ Could not detect LAN IP (agent returned no `ip route get` result); diagnose probes that depend on it will degrade.');
    }
  } catch (e) {
    await log(jobId, `⚠️ LAN IP capture failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // #1668 — reconcile orphan container records from podman's preserved DB.
  //
  // podman's container DB lives on the preserved RAID and survives an
  // OS-disk reinstall, but the quadlet units that managed those containers
  // do not. After a wipe-and-reinstall the DB can hold stale records whose
  // managing `PODMAN_SYSTEMD_UNIT` no longer exists on disk — they surface
  // as ghost "Unmanaged Bundle" pods (e.g. an exited `hermes-hermes`
  // labelled `PODMAN_SYSTEMD_UNIT=hermes.service` where that unit is gone).
  //
  // The reconcile is STRICT: it removes only records that are labelled +
  // not running + whose managing unit file is absent. The CURRENT running
  // hermes/OSCAR service (running, quadlet present) is never touched.
  // Best-effort — a failure here must not block the install.
  try {
    const { reconcileOrphanContainers } = await import('./reconcileOrphanContainers');
    const result = await reconcileOrphanContainers(undefined);
    if (result.removed.length > 0) {
      await log(jobId, `Reconciled ${result.removed.length} orphan container record(s) from preserved storage: ${result.removed.join(', ')}`);
    }
    if (result.failed.length > 0) {
      await log(jobId, `⚠️ ${result.failed.length} orphan container(s) could not be removed: ${result.failed.map(f => f.name).join(', ')}`);
    }
  } catch (e) {
    await log(jobId, `(note) orphan-container reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  const checked = input.items.filter(i => i.checked);
  if (checked.length === 0) {
    await log(jobId, '⚠️ No services selected to install — aborting.');
    await patchJob(jobId, { phase: 'done', endedAt: new Date().toISOString(), credentialsManifest: [] });
    return;
  }

  // #1806 — pull external registries BEFORE resolving any template YAML /
  // post-deploy script. `syncRegistries()` previously ran only at server
  // startup (server.ts), so an install fired after a registry commit landed
  // — without an SB container restart — resolved `getTemplateYaml()` /
  // `getTemplatePostDeployScript()` from the STALE on-disk clone and silently
  // ran the old script (caught twice in solbay box-verifies for #314/#315,
  // worked around by a manual `podman exec servicebay git pull`). Syncing at
  // the start of every deploy makes the install always run the committed
  // artifacts. Best-effort: syncRegistries isolates per-registry errors and
  // no-ops when no external registries are configured, so a transient fetch
  // failure must not block the install — it falls back to the existing clone.
  try {
    await syncRegistries();
    await log(jobId, 'Refreshed external registries to latest committed templates/scripts.');
  } catch (e) {
    await log(jobId, `⚠️ Registry refresh failed (${e instanceof Error ? e.message : String(e)}); installing from the existing on-disk clone.`);
  }

  // Topo-sort by install-time dependencies. We also tag each item
  // with its `servicebay.tier` so the sort adds an implicit edge from
  // every feature to every infrastructure item — guaranteeing the
  // whole infra block (nginx, auth, adguard, …) is fully deployed
  // before any feature can register against it (#796). Without that
  // gate, an unrelated feature with no declared deps (ollama, hermes)
  // races nginx and ends up registering NPM proxy hosts that the
  // late-running NPM credentials self-heal then wipes.
  // A dependency is satisfied by anything already deployed on the node, not
  // just by items re-selected in this batch. Fold the live twin's service
  // names in (node-scoped) so installing e.g. `hermes` isn't wrongly blocked
  // on `home-assistant` when HA is already running but wasn't re-checked.
  const installNode = input.node || 'Local';
  const deployedOnNode = (getStoreSnapshot().nodes?.[installNode]?.services ?? []).map(s => s.name);
  const sortResult = topoSortByDependencies(
    checked.map(i => ({
      name: i.name,
      checked: i.checked,
      alreadyInstalled: i.alreadyInstalled,
      yaml: i.yaml,
      configFiles: i.configFiles,
      dependencies: i.dependencies ?? [],
      tier: i.yaml ? parseTemplateTier(i.yaml) : 'feature',
    })),
    { alreadyInstalled: resolveAlreadyInstalled(input.items, deployedOnNode) },
  );
  if (!sortResult.ok) {
    const msg = sortResult.reason === 'missing'
      ? `Cannot install ${sortResult.item}: it depends on ${sortResult.missing.join(', ')}, which ${sortResult.missing.length === 1 ? 'is' : 'are'} not selected. Go back and check ${sortResult.missing.length === 1 ? 'that template' : 'those templates'}, or unselect ${sortResult.item}.`
      : `Templates form a dependency cycle (${sortResult.involved.join(' ↔ ')}). This is a template-authoring bug — please report it.`;
    await log(jobId, `❌ ${msg}`);
    await patchJob(jobId, { phase: 'error', endedAt: new Date().toISOString(), error: msg });
    return;
  }
  const selected = sortResult.ordered;
  const sortedNames = selected.map(s => s.name).join(' → ');
  const checkedNames = checked.map(c => c.name).join(' → ');
  if (sortedNames !== checkedNames) {
    await log(jobId, `Install order (by dependencies): ${sortedNames}`);
  }

  const reusedSecretNames = new Set<string>();
  const ctx: DeployContext = { jobId, input, scriptCredentials, deployed: [], reusedSecretNames };

  // Secret reuse (#615) — before any deploy fires, override the wizard's
  // freshly-generated `type: secret | bcrypt | rsa-private` values with
  // whatever the saved state has for the same `varName`. Without this,
  // a clean install that preserves `secrets`/`identity` regenerates
  // LLDAP_ADMIN_PASSWORD (and friends), the new value mismatches the
  // still-on-disk LDAP DB hash, and post-deploy.py's seed call gets a
  // 401 from LLDAP. The operator's recovery path was "wipe the data dir
  // and reinstall", which silently destroys identity state — the
  // opposite of what they ticked.
  //
  // #1585 — saved secrets are ALWAYS reused. ServiceBay's identity (saved
  // secret-typed variables, secret.key, tokens) is never wiped by the install
  // runner under any wipeMode: `wipe-config`/`wipe-all` clear a SERVICE's
  // config/data, not ServiceBay's own identity. Wiping identity is the
  // build-time `FACTORY_FRESH=wipe-configs` flag's job — a different mechanism
  // entirely (see jobStore.WipeMode). So the old `shouldReuseSecrets` (which
  // already collapsed to constant-true once cleanInstall was pinned false) is
  // dropped in favour of always reusing.
  //
  // The legacy NPM-specific block below is now subsumed by this general
  // path; kept anyway because it has a specific cert-archive-was-just-
  // restored log line that helps operators reason about what happened.
  // Names of secret-typed variables we reused from saved state. The
  // Authelia-storage self-heal below reads this to decide whether the
  // encryption key matches existing on-disk Authelia storage or is
  // freshly generated.
  {
    try {
      const { getConfig } = await import('@/lib/config');
      const { loadSavedSecrets } = await import('./savedSecrets');
      const saved = loadSavedSecrets(await getConfig());
      const overrideNames: string[] = [];
      for (const v of input.variables) {
        // `meta` is `unknown` on the persisted JobInputVariable shape —
        // narrow to the {type} subset we need without reaching for
        // VariableMeta (a UI-side type).
        const type = (v.meta as { type?: string } | undefined)?.type;
        if (type !== 'secret' && type !== 'bcrypt' && type !== 'rsa-private') continue;
        const stored = saved[v.name];
        if (!stored) continue;
        // Track the reuse even when value already matches — downstream
        // self-heals only care whether the value came from saved state.
        reusedSecretNames.add(v.name);
        if (stored === v.value) continue;
        v.value = stored;
        overrideNames.push(v.name);
      }
      if (overrideNames.length > 0) {
        await log(jobId, `🔑 Reusing ${overrideNames.length} saved secret${overrideNames.length === 1 ? '' : 's'} from before the reset (${overrideNames.slice(0, 4).join(', ')}${overrideNames.length > 4 ? `, +${overrideNames.length - 4} more` : ''}) so services with preserved data volumes can still authenticate.`);
      }
    } catch (e) {
      // Best-effort — a missing config or decryption failure shouldn't
      // block the install. The wizard's regenerated values still flow
      // through; we just lose the reuse benefit for this run.
      await log(jobId, `(note) could not load saved secrets: ${e instanceof Error ? e.message : String(e)}. Continuing with wizard-generated values.`);
    }
  }

  // Authelia storage self-heal — Authelia encrypts its SQLite storage
  // with AUTHELIA_STORAGE_ENCRYPTION_KEY. If the data dir survives a
  // reinstall but the new key doesn't match what encrypted that data,
  // Authelia crashes on startup ("encryption key does not appear to be
  // valid for this database") and loops indefinitely.
  //
  // We track a SHA-256 fingerprint of the encryption key in a sidecar
  // file (`.sb-key-fingerprint`) inside the data dir. On every install
  // where auth is being deployed:
  //   - If the fingerprint file matches the new key → keep the data.
  //   - If it exists and differs → wipe (real mismatch, Authelia would crash).
  //   - If it's missing → fall back to the legacy heuristic: wipe iff
  //     the data dir has content AND the key was freshly generated
  //     (not reused from savedSecrets). This covers pre-fingerprint
  //     upgrades.
  // After deciding, write the new fingerprint so the next install can
  // check it. LLDAP user accounts at the sibling `auth/lldap` host
  // path are preserved either way.
  const authIncluded = selected.some(s => s.name === 'auth' && !s.alreadyInstalled);
  if (authIncluded) {
    try {
      const { agentManager } = await import('@/lib/agent/manager');
      const { getConfig } = await import('@/lib/config');
      const cfg = await getConfig();
      const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
      const autheliaDataPath = `${dataDir}/auth/authelia-data`;
      const fingerprintPath = `${autheliaDataPath}/.sb-key-fingerprint`;
      const newKey = input.variables.find(v => v.name === 'AUTHELIA_STORAGE_ENCRYPTION_KEY')?.value || '';
      const newFp = newKey
        ? crypto.createHash('sha256').update(newKey).digest('hex')
        : '';
      const node = input.node || 'Local';
      const agent = await agentManager.ensureAgent(node);
      // Probe both the fingerprint and any other content in the dir in
      // one round-trip. Output format: "FP=<hex|>\nCONTENT=<something|>"
      const probe = await agent.sendCommand('exec', {
        command:
          `printf 'FP=%s\\n' "$(cat "${fingerprintPath}" 2>/dev/null || true)"; ` +
          `printf 'CONTENT=%s\\n' "$([ -d "${autheliaDataPath}" ] && find "${autheliaDataPath}" -mindepth 1 -maxdepth 1 -not -name .sb-key-fingerprint | head -1 || true)"`,
      });
      const out = probe.stdout || '';
      const recordedFp = (out.match(/^FP=([a-f0-9]{64})$/m)?.[1] || '').trim();
      const hasContent = !!(out.match(/^CONTENT=(.+)$/m)?.[1] || '').trim();
      let shouldWipe = false;
      let reason = '';
      if (recordedFp) {
        if (newFp && recordedFp !== newFp) {
          shouldWipe = true;
          reason = 'encryption-key fingerprint changed since the last successful deploy';
        }
      } else if (hasContent && !reusedSecretNames.has('AUTHELIA_STORAGE_ENCRYPTION_KEY')) {
        // Legacy path: no fingerprint recorded (pre-fix install) but data
        // exists and the new key isn't from savedSecrets — almost certainly
        // a key mismatch.
        shouldWipe = true;
        reason = 'data dir has content, encryption key was freshly generated, and no fingerprint exists to prove the key matches';
      }
      if (shouldWipe) {
        await log(jobId, `🔄 Wiping Authelia storage at ${autheliaDataPath} — ${reason} (LLDAP users at ${dataDir}/auth/lldap are kept).`);
        await agent.sendCommand('exec', { command: `rm -rf "${autheliaDataPath}"` });
        await log(jobId, `✅ Authelia storage cleared. Authelia will bootstrap fresh on first start.`);
      }
      // Always (re)create the dir and stamp the new fingerprint. Done
      // after a potential wipe so it lands in the recreated dir.
      if (newFp) {
        await agent.sendCommand('exec', {
          command:
            `mkdir -p "${autheliaDataPath}" && chown core:core "${autheliaDataPath}" && ` +
            `printf '%s\\n' "${newFp}" > "${fingerprintPath}"`,
        });
      }
    } catch (e) {
      // Best-effort: if probe/wipe fails the install will hit the
      // readiness-probe 5-min timeout. Surface the recovery one-liner
      // so the operator can unstick themselves manually.
      const dataDirFallback = (await getConfig()).templateSettings?.DATA_DIR || '/mnt/data/stacks';
      await log(jobId, `(note) couldn't auto-clear Authelia storage: ${e instanceof Error ? e.message : String(e)}. If readiness times out, SSH to the node and \`rm -rf ${dataDirFallback}/auth/authelia-data\` before retrying.`);
    }
  }

  // LLDAP admin-password self-heal (#666 / ARCH-15). LLDAP only seeds its
  // admin password from env on first DB init; on a reinstall over a
  // preserved users.db the DB keeps its old admin password while Authelia
  // binds with this install's LLDAP_ADMIN_PASSWORD → "Invalid Credentials"
  // crash loop. `authDynamicVars` forces LLDAP_FORCE_LDAP_USER_PASS_RESET=
  // always on every auth deploy to re-sync it (idempotent, non-destructive
  // — user accounts are preserved). This block just surfaces a log when an
  // existing DB is present so the operator sees why the bind gets re-keyed.
  // Note: deliberately NOT gated on `!reusedSecretNames.has(...)` — once a
  // saved secret and a preserved DB diverge, that heuristic misses the
  // mismatch and the bind fails forever.
  if (authIncluded) {
    try {
      const { agentManager } = await import('@/lib/agent/manager');
      const { getConfig } = await import('@/lib/config');
      const cfg = await getConfig();
      const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
      const lldapDbPath = `${dataDir}/auth/lldap/users.db`;
      const node = input.node || 'Local';
      const agent = await agentManager.ensureAgent(node);
      const probe = await agent.sendCommand('exec', {
        command: `[ -s "${lldapDbPath}" ] && echo present || true`,
      });
      const dbPresent = (probe.stdout || '').trim() === 'present';
      if (dbPresent) {
        await log(jobId, `🔄 Existing LLDAP database found — re-syncing the admin bind to this install's password (LLDAP_FORCE_LDAP_USER_PASS_RESET=always) so a preserved users.db can't lock Authelia out. User accounts are preserved.`);
      }
    } catch (e) {
      await log(jobId, `(note) LLDAP drift probe failed: ${e instanceof Error ? e.message : String(e)} — continuing.`);
    }
  }

  // Cert archive restore — runs once before the deploy loop when nginx
  // is in the install set AND the volume on disk is empty (fresh
  // install). The reset endpoint snapshots NPM's data dir to
  // /mnt/data/servicebay/cert-archive/ before wiping; restoring the
  // most-recent snapshot here lets NPM come up with the previous
  // certificate + sqlite-DB state intact, so re-issuance is skipped
  // and we don't burn LE's 5-duplicate-certs-per-168h limit.
  if (selected.some(s => s.name === 'nginx' && !s.alreadyInstalled)) {
    try {
      const { agentManager } = await import('@/lib/agent/manager');
      const { getConfig } = await import('@/lib/config');
      const cfg = await getConfig();
      const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
      const node = input.node || 'Local';
      const agent = await agentManager.ensureAgent(node);
      // Only restore on a fresh NPM dir — leave existing cert state
      // alone so a re-deploy that isn't preceded by a reset doesn't
      // clobber whatever the operator did since the last archive.
      const probe = await agent.sendCommand('exec', {
        command: `[ -d "${dataDir}/nginx-proxy-manager" ] && find "${dataDir}/nginx-proxy-manager" -mindepth 1 -maxdepth 1 | head -1 || true`,
      });
      const npmDirHasContent = !!(probe.stdout || '').trim();
      if (!npmDirHasContent) {
        const newest = await agent.sendCommand('exec', {
          command: `ls -1t /mnt/data/servicebay/cert-archive/npm-*.tar.gz 2>/dev/null | head -1 || true`,
        });
        const archivePath = (newest.stdout || '').trim();
        if (archivePath) {
          await log(jobId, `🔒 Restoring NPM cert archive from ${archivePath} — skipping re-issuance against Let's Encrypt.`);
          await agent.sendCommand('exec', {
            command: `mkdir -p "${dataDir}" && tar xzf "${archivePath}" -C "${dataDir}"`,
          });
          await log(jobId, `✅ Cert archive restored. NPM will pick up existing certs on first start.`);

          // The archive contains NPM's sqlite DB, which has the previous
          // admin credentials bcrypt-hashed inside. NPM ignores
          // INITIAL_ADMIN_* env vars when the user table is already
          // seeded, so the wizard's fresh random NGINX_ADMIN_PASSWORD
          // would never authenticate — bootstrap times out, all cert
          // requests cascade-fail with "defaults_rejected". Saved creds
          // from config.reverseProxy.npm survived the reset (it only
          // wipes service data, not config), so override the wizard's
          // generated values with them to match what's actually in the
          // restored DB.
          const savedEmail = cfg.reverseProxy?.npm?.email;
          const savedPassword = cfg.reverseProxy?.npm?.password;
          if (savedEmail && savedPassword) {
            // Mutate `input.variables` in-place. The deploy loop reads
            // through the same reference (see line 268), so the
            // override propagates without persisting back to the job
            // state. `updateJob` deliberately disallows input updates
            // to keep the wizard's submitted intent immutable on disk
            // — a server restart mid-install transitions the job to
            // `crashed` anyway, and the operator restarts from the
            // wizard with fresh state.
            let overrode = false;
            for (const v of input.variables) {
              if (v.name === 'NGINX_ADMIN_EMAIL' && v.value !== savedEmail) {
                v.value = savedEmail;
                overrode = true;
              }
              if (v.name === 'NGINX_ADMIN_PASSWORD' && v.value !== savedPassword) {
                v.value = savedPassword;
                overrode = true;
              }
            }
            if (overrode) {
              await log(jobId, `🔑 Reusing NPM admin (${savedEmail}) from before the reset so the restored DB stays accessible.`);
            }
          } else {
            await log(jobId, `(note) cert archive restored, but no NPM admin password saved in config — bootstrap will likely prompt for the existing password.`);
          }
        }
      }
    } catch (e) {
      // Best-effort — a restore failure shouldn't block the install.
      // Operator can always click "Retry Let's Encrypt" in NPM later.
      await log(jobId, `(note) cert archive restore skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Parallel pre-pull — warm up every container image referenced by the
  // selected items before the sequential deploy loop. Pulls are the
  // long pole of a cold install (multi-GB layers over a 5 Mbps line),
  // and they have no install-ordering dependency on each other. Doing
  // them in parallel cuts the cold-install wall-clock time roughly
  // linearly with the number of independent images.
  //
  // Best-effort: a failed pull does NOT abort the install. The
  // subsequent unit start will trigger a sequential retry via Quadlet's
  // own image-pull path; the operator just loses the parallelism
  // benefit for that one image.
  // Render image refs against the wizard variables so templates that
  // interpolate `image: {{VAR}}` get a real registry reference at
  // pre-pull time, not the literal placeholder. #1170.
  const prePullView = (input.variables as StackVariable[]).reduce<Record<string, string>>((acc, v) => {
    if (typeof v.value === 'string') acc[v.name] = v.value;
    return acc;
  }, {});
  const imagesToPull = collectImagesToPull(selected, prePullView);
  if (imagesToPull.length > 0) {
    await log(jobId, `📦 Pre-pulling ${imagesToPull.length} container image${imagesToPull.length === 1 ? '' : 's'} in parallel...`);
    const node = input.node || 'Local';
    try {
      const { agentManager } = await import('@/lib/agent/manager');
      const agent = await agentManager.ensureAgent(node);
      // Per-image progress (#805). The agent emits PULL_PROGRESS per layer
      // (docker-compat stream: status + byte progress + "Already exists" for
      // cached layers). A PullTracker aggregates layers into one coalesced
      // line every ~2s — bytes + percent once known, otherwise a "preparing"
      // heartbeat — so a large pull never looks hung and the operator sees how
      // many layers were already on the box.
      const trackers = new Map<string, PullTracker>();
      const lastEmit = new Map<string, number>();
      const onProgress = (image: string) => (ev: { id?: string; status?: string; current?: number; total?: number }) => {
        let tracker = trackers.get(image);
        if (!tracker) { tracker = new PullTracker(); trackers.set(image, tracker); }
        tracker.update(ev);
        const now = Date.now();
        if (now - (lastEmit.get(image) ?? 0) < 2000) return;
        lastEmit.set(image, now);
        const line = describePull(image, tracker.summary(), humanBytes);
        if (line) void log(jobId, `  ${line}`);
      };
      const results = await Promise.allSettled(
        imagesToPull.map(image => agent.pullImage(image, onProgress(image))),
      );
      let okCount = 0;
      const failures: { image: string; reason: string }[] = [];
      results.forEach((r, i) => {
        const image = imagesToPull[i];
        if (r.status === 'fulfilled' && r.value?.success) {
          okCount++;
        } else {
          const reason = r.status === 'rejected'
            ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
            : 'agent reported failure';
          failures.push({ image, reason });
        }
      });
      await log(jobId, `✅ Pulled ${okCount}/${imagesToPull.length} image${imagesToPull.length === 1 ? '' : 's'}.`);
      for (const f of failures) {
        const s = trackers.get(f.image)?.summary();
        const got = s && s.bytesTotal > 0
          ? ` (reached ${humanBytes(s.bytesCurrent)}/${humanBytes(s.bytesTotal)}${s.cached ? `, ${s.cached} cached` : ''})`
          : '';
        await log(jobId, `(note) pre-pull failed for ${f.image}: ${f.reason}${got} — will be retried during deploy.`);
      }
    } catch (e) {
      await log(jobId, `(note) parallel pre-pull skipped: ${e instanceof Error ? e.message : String(e)} — deploy will pull sequentially as usual.`);
    }
  }

  // Deploy loop.
  for (const item of selected) {
    if (abortFlags.get(jobId)) {
      await patchJob(jobId, {
        phase: 'aborted',
        endedAt: new Date().toISOString(),
        error: 'Installation aborted by user.',
      });
      await log(jobId, '⛔ Install aborted by user.');
      return;
    }
    if (item.alreadyInstalled) {
      await log(jobId, `✅ ${item.name} already installed, skipping.`);
      ctx.deployed.push({ name: item.name });
      continue;
    }
    // #810 — gate on dependency readiness before deploying. The item's
    // post-deploy script runs inside `deployItem`, so a dependency that
    // is merely ordered ahead (not yet healthy) would otherwise be hit
    // mid-boot.
    await waitForDependencies(jobId, item, input.node || 'Local');
    if (abortFlags.get(jobId)) {
      await patchJob(jobId, {
        phase: 'aborted',
        endedAt: new Date().toISOString(),
        error: 'Installation aborted by user.',
      });
      await log(jobId, '⛔ Install aborted by user.');
      return;
    }
    try {
      const ok = await deployItem(ctx, item);
      if (ok) ctx.deployed.push({ name: item.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await patchJob(jobId, { phase: 'error', endedAt: new Date().toISOString(), error: msg });
      return;
    }
  }

  // Register newly-deployed services with the health poller (#627).
  // The bootstrap walks every service in the twin and registers each
  // one whose template ships a `servicebay.healthcheck` annotation;
  // the poller's register() fires an immediate probe so settleWait
  // below sees `twin.health.ready` populate within seconds, not on
  // the next 30s tick.
  try {
    const { bootstrapServiceHealth } = await import('@/lib/health/serviceHealthBootstrap');
    await bootstrapServiceHealth(input.node || 'Local');
  } catch (e) {
    await log(jobId, `(note) couldn't refresh service-health registrations: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Post-install — NPM bootstrap (seeds admin creds). #632 moved the
  // bulk proxy-host / OIDC-client / DNS-rewrite / credentials-manifest
  // work to capability handlers; this section only handles the operator-
  // interactive NPM credentials prompt that doesn't fit the bus pattern.
  const variables = input.variables as StackVariable[];
  const newlyDeployed = new Set(ctx.deployed.map(d => d.name).filter(name => {
    const item = input.items.find(i => i.name === name);
    return item && !item.alreadyInstalled;
  }));

  if (newlyDeployed.has('nginx')) {
    const bootstrap = await bootstrapNpmAdmin({
      variables,
      node: input.node || undefined,
      onLog: (line: string) => { void log(jobId, line); },
    });
    let bootstrapState: 'ok' | 'needs_credentials' | 'skipped' = bootstrap;

    // Self-heal whenever NPM rejects every credential we know about
    // (#704, broadened in #TBD). The operator's data volume kept the
    // OLD admin bcrypt; the wizard's INITIAL_ADMIN_PASSWORD env never
    // overwrites an existing admin user. The pre-fix flow paused for
    // the operator to type the old password — which they typically
    // don't have (forgotten, never copied off the credentials banner).
    // Auto-wipe the NPM data dir (admin sqlite + sites table) and
    // retry bootstrap; letsencrypt/ stays untouched so cert files
    // survive — the heal targets only the stale admin DB, never the certs.
    //
    // #1585 — re-expressed against the wipeMode model's data-keep semantics.
    // The heal is intrinsically cert-preserving (it removes only
    // `nginx-proxy-manager/data`, leaving `letsencrypt/`), so it applies for
    // any mode that keeps NPM's certs on disk: `install` and `wipe-config`
    // (both keep DATA, i.e. letsencrypt/). On `wipe-all` the whole NPM dir was
    // already cleared by the per-service wipe, so there's no stale admin DB to
    // heal — skip. (Previously gated on the inert `preserve?.includes('certs')`
    // which collapsed to constant-true.)
    if (
      bootstrapState === 'needs_credentials'
      && input.wipeMode !== 'wipe-all'
    ) {
      const node = input.node || 'Local';
      const dataDir = (await getConfig()).templateSettings?.DATA_DIR || '/mnt/data/stacks';
      await log(jobId, '🔄 NPM rejected the wizard credentials (stale admin from a prior install). Wiping NPM data/ — letsencrypt/ certs preserved.');
      try {
        const { agentManager } = await import('@/lib/agent/manager');
        const agent = await agentManager.ensureAgent(node);
        await agent.sendCommand('exec', {
          command: `systemctl --user stop nginx.service 2>&1 || true; rm -rf "${dataDir}/nginx-proxy-manager/data"; systemctl --user start nginx.service 2>&1 || true`,
        });
        // Give NPM 30s to bootstrap fresh from INITIAL_ADMIN_* env.
        await new Promise(r => setTimeout(r, 30_000));
        const retry = await bootstrapNpmAdmin({
          variables,
          node: input.node || undefined,
          onLog: (line: string) => { void log(jobId, line); },
          // Tells the bootstrap helper to suppress the duplicated 90 s
          // preamble and emit a post-self-heal success line on
          // already_using_target (#733). Also caps the server-side
          // retry budget at 20 s — the user table is already seeded.
          phase: 'retry',
        });
        if (retry === 'ok') {
          bootstrapState = 'ok';
        } else {
          await log(jobId, '⚠️ NPM still rejecting credentials after data-wipe retry; falling back to the credentials prompt.');
        }
      } catch (e) {
        await log(jobId, `⚠️ NPM self-heal failed (${e instanceof Error ? e.message : String(e)}); falling back to the credentials prompt.`);
      }
    }

    if (bootstrapState === 'needs_credentials') {
      // Prefer credentials saved in config over wizard's newly-generated
      // ones — we're in this branch because NPM rejected the wizard
      // values, so re-prompting with the same string is just confusing.
      const savedNpm = (await getConfig()).reverseProxy?.npm;
      const fallback = {
        email: savedNpm?.email
          || variables.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value
          || '',
        password: savedNpm?.password
          || variables.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value
          || '',
      };
      const creds = await waitForCredentials(jobId, fallback);
      if (abortFlags.get(jobId)) {
        await patchJob(jobId, { phase: 'aborted', endedAt: new Date().toISOString() });
        return;
      }
      if (creds) {
        await patchJob(jobId, { phase: 'running', needsCredentials: undefined });
        // Persist so the nginx capability handler (and every other call
        // site through getNpmToken) picks up these creds.
        await apiFetch('/api/system/nginx/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(creds),
        }).catch(() => undefined);
        // Also override the in-memory variables so subsequent emits use
        // them (the proxy-host POST honours wizard-generated creds, but
        // operator-supplied ones land in config and get picked up via
        // getNpmToken's fallback chain).
        for (const v of variables) {
          if (v.name === 'NGINX_ADMIN_EMAIL') v.value = creds.email;
          if (v.name === 'NGINX_ADMIN_PASSWORD') v.value = creds.password;
        }
        await log(jobId, 'Saved NPM credentials for future installs.');
      } else {
        await log(jobId, '⚠️ NPM credentials skipped — proxy routes may not be configured.');
        await patchJob(jobId, { phase: 'running', needsCredentials: undefined });
      }
    }
  }

  // Per-template capability events (#632). Each newly-deployed template
  // fires `feature.installed`; subscribed handlers (Authelia OIDC, NPM
  // proxy hosts, AdGuard DNS, credentials manifest) do their cross-
  // service registration. Handlers are idempotent — re-emitting is safe.
  const bus = getCapabilityBus();
  for (const name of newlyDeployed) {
    try {
      const yamlText = await getTemplateYaml(name, input.templateSource);
      if (!yamlText) {
        await log(jobId, `(note) skipped capability emit for ${name}: template.yml not found`);
        continue;
      }
      const parsed = parseTemplateManifest(yamlText);
      if (!parsed.ok) {
        await log(jobId, `(note) skipped capability emit for ${name}: ${parsed.errors.join('; ')}`);
        continue;
      }
      const result = await bus.emit({
        kind: 'feature.installed',
        template: name,
        manifest: parsed.manifest,
        variables,
      });
      for (const f of result.failures) {
        // Surface as diagnose-style log lines but don't abort — handler
        // failures are recoverable and the operator can retry the
        // specific service via diagnose actions.
        if (!f.result.ok) {
          await log(jobId, `⚠️ ${f.handler} (${name}): ${f.result.message}`);
        }
      }
    } catch (e) {
      await log(jobId, `(note) capability emit failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // NPM admin self-heal (#1268, credential-reconciliation ARCH-15) — must run
  // BEFORE proxy-host + portal provisioning (both need a working NPM admin
  // login) and on EVERY install, not just when nginx is freshly installed.
  // The failing case (#1268): a new stack with an internal subdomain installed
  // onto a box whose nginx was already present with an empty/diverged NPM
  // password — the old gate (fresh-nginx only, and positioned after this step)
  // skipped the heal, so per-service proxy hosts + portal routing failed with
  // no recovery on every (re)install. npmAdminCredStatus self-skips ('unknown')
  // when NPM isn't reachable, so this is a cheap no-op for NPM-less installs.
  // Best-effort; never fatal (the npm_data_stale diagnose action is the manual
  // fallback). rekeyNpmAdmin writes NPM's admin hash directly, so it recovers
  // even when ServiceBay's stored password is empty.
  try {
    const npmNode = input.node || 'Local';
    const status = await npmAdminCredStatus(npmNode);
    if (status === 'rejected' || status === 'no-creds') {
      await log(jobId, '🔑 NPM is rejecting/missing the stored admin credentials — re-keying in place (proxy routes preserved)…');
      const r = await rekeyNpmAdmin(npmNode);
      await log(jobId, (r.ok ? '✅ ' : '⚠️ ') + r.message);
    }
  } catch (e) {
    await log(jobId, `(note) NPM admin reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  // #807 — guarantee every service subdomain has an NPM proxy host,
  // regardless of whether each per-template `feature.installed` emit
  // created its own. Idempotent: re-creating an existing host no-ops.
  await ensureProxyHosts(jobId, variables, input.node);

  // #989 — same guarantee for Authelia OIDC clients. Per-template emits
  // are fragile (auth pod restarts between writes, race against config
  // read), and a missed registration only surfaces when the operator
  // tries to SSO into the affected service.
  await ensureOidcClients(jobId, Array.from(newlyDeployed), variables);

  // #1761 — Hermes ships as an external OSCAR template ServiceBay doesn't
  // render, so the engine's API_SERVER_KEY and ServiceBay's stored
  // HERMES_API_KEY drift on (re)deploy → chat route gets 401. When hermes
  // was deployed in this install, adopt the running engine's key
  // (reconcile-not-generate). Best-effort; the diagnose heal-action retries.
  await ensureHermesApiKey(jobId, Array.from(newlyDeployed), input.node);

  // Build the final credentials manifest for the Done UI. Handler
  // already persisted per-template entries to `config.installManifest`
  // (credentials capability handler); this builds the JOB-STATE manifest
  // the wizard's Done step reads.
  const manifest = [
    ...buildCredentialsManifest({ variables, host: input.host }),
    ...scriptCredentials,
  ];
  await patchJob(jobId, { credentialsManifest: manifest });

  // Persist the manifest to `config.installManifest` — the store the
  // Settings → Saved Credentials page reads. The per-template
  // credentials capability handler only emits OIDC client_secrets, so
  // without this end-of-job write the post-deploy service logins
  // (LLDAP, NPM, AdGuard, Jellyfin, Samba, …) never reach the
  // persistent store and the page shows empty. Merged per-template so a
  // feature-only install doesn't drop credentials from earlier installs.
  try {
    const cfg = await getConfig();
    const merged = mergeCredentials(
      (cfg.installManifest?.credentials ?? []) as Credential[],
      manifest,
      ctx.deployed.map(d => d.name),
    );
    await saveConfig({
      ...cfg,
      installManifest: {
        savedAt: new Date().toISOString(),
        credentials: merged as unknown as InstalledCredential[],
      },
    });
    await log(jobId, `Saved ${manifest.length} credential(s) to the install manifest.`);
  } catch (e) {
    await log(jobId, `(note) couldn't persist the credentials manifest: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Settle-wait against the in-process digital twin FIRST, so the
  // services portal routing depends on (nginx, AdGuard) are actually
  // active — and AdGuard's post-deploy hook has had a chance to write
  // its admin creds — before we try to provision. Running portal
  // provisioning ahead of this fired it against not-yet-healthy
  // containers, which on a fresh install reported a misleading failure
  // (the proxy/DNS *were* being installed, just not up yet).
  await settleWait(jobId, ctx.deployed, input.node || 'Local');

  // Portal routing — apex + wildcard rewrites for the active domain.
  // Always runs after a successful install (#707). Pre-fix this was
  // gated on `adguard ∈ newlyDeployed`, which meant a feature-only
  // install (e.g. operator adds the `cloud` stack to an existing
  // host) silently skipped DNS-rewrite provisioning even though new
  // subdomains were being created. Now run it whenever the
  // prerequisites (publicDomain + AdGuard reachable) are met; the
  // provisioner reports a calm skip only when nginx/AdGuard aren't
  // part of this install at all.
  await log(jobId, 'Provisioning AdGuard DNS rewrites + portal routing...');
  await provisionPortalWithRetries((line: string) => { void log(jobId, line); });

  // #1675 — now that AdGuard is up, re-point the BOX's own resolver at it
  // (127.0.0.1) with the router as fallback and NO public 8.8.8.8. The
  // install baked a public fallback for bootstrap (before AdGuard existed);
  // leaving it in place lets the box resolve `*.<publicDomain>` to the
  // PUBLIC IP, the #1559 trap one layer down. Best-effort: a failure logs
  // and never fails the install.
  try {
    const { repointBoxResolverToAdguard } = await import('@/lib/router/boxResolverDns');
    const dnsResult = await repointBoxResolverToAdguard(input.node || 'Local');
    if (dnsResult.result === 'ok') {
      await log(jobId, `✅ ${dnsResult.detail}`);
    } else {
      await log(jobId, `(note) box resolver re-point skipped/failed: ${dnsResult.detail}`);
    }
  } catch (e) {
    await log(jobId, `(note) box resolver re-point failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await patchJob(jobId, {
    phase: 'done',
    endedAt: new Date().toISOString(),
    progress: {
      currentItem: null,
      deployedNames: ctx.deployed.map(d => d.name),
      totalCount: input.items.filter(i => i.checked).length,
    },
  });

  // Persist every secret-typed variable so the next install can reuse
  // them (#615). Has to happen after `phase: 'done'` because we only
  // want to record values from a successful run — a half-failed install
  // might have rewritten LLDAP's DB with a new password mid-flight, and
  // the operator's recovery action could be to retry with the previous
  // value. Best-effort: a write failure here doesn't fail the install
  // (config might be temporarily locked); the next successful install
  // gets another chance.
  try {
    const { persistInstalledSecrets } = await import('./savedSecrets');
    await persistInstalledSecrets(input.variables, await getConfig());
  } catch (e) {
    await log(jobId, `(note) couldn't persist installed secrets: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The CoreOS first-boot installer writes `stackSetupPending: true`
  // to flag "we set the box up, but no stack services are deployed
  // yet". The OnboardingWizard / Sidebar / /setup page all read that
  // flag. Historically it was only cleared by the operator clicking
  // "Finish" on /setup — so even after one or many successful
  // installs the flag stayed armed, the wizard's auto-open kept
  // suppressing (terminal-job + stackSetupPending branch), and a
  // re-install required clicking Finish on the *old* setup view
  // first. Now: a successful install proves the operator has stack
  // services. Clear the flag inline so the next re-install flow
  // doesn't get gated by stale onboarding state.
  try {
    const cfg = await getConfig();
    if (cfg.stackSetupPending) {
      delete cfg.stackSetupPending;
      await saveConfig(cfg);
    }
  } catch (e) {
    // Best-effort: a config write failure shouldn't fail the install
    // job itself — the operator can always click Finish manually.
    await log(jobId, `(note) couldn't clear stackSetupPending: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Fire the end-to-end SSO verification (#1454, consumes #1453). Detached +
  // fully best-effort — see runPostInstallSsoVerify.
  void runPostInstallSsoVerify(jobId, input.node);
}

/**
 * Run the end-to-end SSO verification after a successful install and persist
 * the report (#1454, consumes #1453). Confirms a real family-group login can
 * reach every user-facing domain and is blocked from admin-only ones, then
 * saves the result so the diagnose `sso_verify` probe (#1455) surfaces it.
 *
 * Detached + fully best-effort: `verifySso` creates and *always* deletes an
 * ephemeral user, takes ~10-20 s, and must never block or fail the install.
 * A non-auth install is a calm skip inside `verifySso`. Any error here is
 * logged to the job and swallowed.
 */
async function runPostInstallSsoVerify(jobId: string, node: string | undefined): Promise<void> {
  try {
    const { verifySso } = await import('@/lib/diagnose/ssoVerify');
    const { saveSsoVerifyReport } = await import('@/lib/diagnose/ssoVerifyStore');
    const report = await verifySso({ node });
    await saveSsoVerifyReport(report);
    await log(
      jobId,
      report.ok
        ? 'SSO verification passed (per-domain report saved — see the SSO end-to-end check on the Health dashboard).'
        : `SSO verification finished with findings (report saved — see the SSO end-to-end check on the Health dashboard). Ephemeral user cleaned up: ${report.cleanedUp}.`,
    );
  } catch (e) {
    await log(jobId, `(note) post-install SSO verification did not complete: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Public entry-point. Fires off `runJob` as a detached task — caller
 *  returns immediately. Errors are caught and recorded on the job; they
 *  never propagate up because there's no caller waiting for them. */
export function startJob(jobId: string): void {
  void (async () => {
    try {
      await runJob(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await patchJob(jobId, {
        phase: 'error',
        endedAt: new Date().toISOString(),
        error: `Internal runner error: ${msg}`,
      });
    } finally {
      abortFlags.delete(jobId);
      clearPendingCredentials(jobId);
    }
  })();
}
