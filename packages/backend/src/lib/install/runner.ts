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
import Mustache from 'mustache';
// Direct lib imports (#600) — the actions.ts wrappers are RPC bridges
// for client components, not appropriate for server-side lib code.
import {
  getTemplatePostDeployScript,
  getTemplateMigrationScripts,
  getTemplateYaml,
} from '@/lib/registry';
import { parseTemplateSchemaVersion } from '@/lib/templateSchemaVersion';
import { parseTemplateManifest } from '@/lib/template/contract';
import { topoSortByDependencies } from '@/lib/stackInstall/dependencies';
import { parseTemplateTier } from '@/lib/templateTier';
import { selectMigrationChain } from '@/lib/stackInstall/migrations';
import {
  bootstrapNpmAdmin,
  type StackVariable,
} from '@/lib/stackInstall/postInstall';
import { buildCredentialsManifest, type Credential } from '@/lib/stackInstall/credentialsManifest';
import { provisionPortalWithRetries } from '@/lib/stackInstall/portalProvision';
import { getCapabilityBus } from '@/lib/capabilities/bus';
import { DigitalTwinStore } from '@/lib/store/twin';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { getConfig, saveConfig } from '@/lib/config';
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

/** Pending NPM-credentials prompts. The runner sets `phase=needs_credentials`
 *  on the job, then awaits the promise stored here. The credentials API
 *  route resolves it (with creds, or null to skip). On server restart these
 *  are lost — the corresponding job is flipped to `crashed` on boot. */
const pendingCredentials = new Map<string, {
  resolve: (creds: { email: string; password: string } | null) => void;
}>();

/** Loopback fetch helper. proxy.ts middleware gates state-changing API
 *  calls on either a session cookie OR the X-SB-Internal-Token header
 *  (the same token the post-deploy scripts on the agent host use). The
 *  runner has no session, so we attach the token here — without it
 *  every POST /api/services / NPM / portal call from this process gets
 *  403'd by the CSRF check (no Origin header from Node fetch). */
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
  const pending = pendingCredentials.get(jobId);
  if (pending) {
    pendingCredentials.delete(jobId);
    pending.resolve(null);
  }
}

/** Resume a credentials-paused job with operator-supplied values. */
export function provideCredentials(
  jobId: string,
  creds: { email: string; password: string },
): boolean {
  const pending = pendingCredentials.get(jobId);
  if (!pending) return false;
  pendingCredentials.delete(jobId);
  pending.resolve(creds);
  return true;
}

/** Resume a credentials-paused job by skipping NPM. */
export function skipCredentials(jobId: string): boolean {
  const pending = pendingCredentials.get(jobId);
  if (!pending) return false;
  pendingCredentials.delete(jobId);
  pending.resolve(null);
  return true;
}

/** Pause the deploy loop until the operator submits NPM credentials or
 *  skips the prompt. Also unblocks on `abortJob`. */
async function waitForCredentials(
  jobId: string,
  fallback: { email: string; password: string },
): Promise<{ email: string; password: string } | null> {
  await patchJob(jobId, {
    phase: 'needs_credentials',
    needsCredentials: { fallback },
  });
  return new Promise(resolve => {
    pendingCredentials.set(jobId, { resolve });
  });
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
  const twin = DigitalTwinStore.getInstance();
  while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
    if (abortFlags.get(jobId)) return;
    const snapshot = twin.getSnapshot();
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

  const twin = DigitalTwinStore.getInstance();
  const startedAt = Date.now();
  let lastLogAt = startedAt;
  const pending = new Set(deps);
  await log(jobId, `Waiting for ${item.name}'s dependencies to become healthy: ${deps.join(', ')}...`);
  while (pending.size > 0 && Date.now() - startedAt < DEP_READY_TIMEOUT_MS) {
    if (abortFlags.get(jobId)) return;
    const services = twin.getSnapshot().nodes?.[node]?.services ?? [];
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

  const view = (input.variables as StackVariable[]).reduce<Record<string, string>>((acc, v) => {
    acc[v.name] = v.value;
    return acc;
  }, {});
  // Disable HTML escaping — Mustache renders YAML and config files, not HTML.
  const savedEscape = Mustache.escape;
  Mustache.escape = (text: string) => text;
  const yamlContent = Mustache.render(item.yaml, view);
  const kubeContent =
    `[Kube]\nYaml=${item.name}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

  // Sanity-check that every {{VAR}} in a config file has a value. Without
  // this, Mustache renders missing vars as empty strings — silent data
  // loss that produces crash-looping pods with no breadcrumb.
  const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
  for (const cf of (item.configFiles || [])) {
    if (!cf.targetPath) continue;
    const refs = new Set<string>();
    for (const m of cf.content.matchAll(refRe)) refs.add(m[1]);
    const missing = [...refs].filter(r => !(r in view) || view[r] === '');
    if (missing.length > 0) {
      Mustache.escape = savedEscape;
      const msg = `Cannot deploy ${item.name}: ${cf.filename} references variable(s) with no value: ${missing.join(', ')}. ` +
        `Go back to the Configure step and fill them in (or check the template's variables.json defaults).`;
      await log(jobId, `❌ ${msg}`);
      throw new Error(msg);
    }
  }

  const extraFiles = (item.configFiles || [])
    .filter(cf => cf.targetPath)
    .map(cf => ({
      path: Mustache.render(cf.targetPath!, view),
      content: Mustache.render(cf.content, view),
    }));

  // Optional per-template post-deploy.py — server runs it after the unit
  // starts; output streams back via `progress` events. Parsed below for
  // `__SB_CREDENTIAL__ {json}` markers.
  let postDeployScript: string | undefined;
  try {
    const raw = await getTemplatePostDeployScript(item.name, input.templateSource);
    if (raw) postDeployScript = Mustache.render(raw, view);
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
          Mustache.escape = savedEscape;
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
            content: Mustache.render(s.content, view),
          }));
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Migration chain for')) throw e;
    await log(jobId, `⚠️ ${item.name}: could not check migration chain (${e instanceof Error ? e.message : String(e)}). Continuing without migrations.`);
  }
  Mustache.escape = savedEscape;

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
                ctx.scriptCredentials.push(JSON.parse(evt.message.slice('__SB_CREDENTIAL__ '.length)));
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

/** Inner async pipeline — wrapped by `startJob` so the public surface
 *  can stay synchronous (kicks off the work, returns immediately). */
async function runJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const input = job.input;

  // Reset abort flag for this run.
  abortFlags.delete(jobId);

  const scriptCredentials: Credential[] = [];

  // Optional clean-install reset.
  if (input.cleanInstall && input.cleanInstallConfirm === 'RESET') {
    // Per-group preserve flags (#568): operator's checkbox state from
    // the wizard. Omitted entirely → endpoint applies the conservative
    // default (keep secrets + certs + identity, wipe service-data).
    const preserve = input.preserve;
    const previewLabel = preserve === undefined
      ? 'default (keep secrets/certs/identity, wipe service-data)'
      : preserve.length === 0
        ? 'FACTORY RESET — wipe everything'
        : `keep ${preserve.join(' + ')}`;
    await log(jobId, `🧹 Clean install — ${previewLabel}…`);
    try {
      const res = await apiFetch('/api/system/stacks/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: 'RESET',
          node: input.node || undefined,
          ...(preserve !== undefined ? { preserve } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const removed = data.deleted?.length ?? 0;
        const kept = data.preservedServices?.length ?? 0;
        await log(jobId, `✅ Reset done — removed ${removed} service${removed === 1 ? '' : 's'}${kept ? `, kept ${kept} (${(data.preservedServices ?? []).join(', ')})` : ''}.`);
        if (data.wipeStepsRun?.length) {
          await log(jobId, `   Wiped: ${data.wipeStepsRun.join('; ')}.`);
        }
        if (data.certArchive) {
          await log(jobId, `   Archived NPM data to ${data.certArchive} — cert-reuse will pull from it on next install.`);
        }
        if (data.failed?.length) {
          await log(jobId, `⚠️ Some services could not be cleanly removed: ${data.failed.map((f: { name: string }) => f.name).join(', ')}`);
        }
      } else {
        // Pre-fix the runner logged a warning and continued. But the
        // operator typed RESET to confirm they want a clean slate;
        // proceeding to deploy on top of un-wiped state silently
        // violates that promise (existing service data persists,
        // stale containers count as already-installed in the wizard
        // UI, the "8/12 deployed" confusion). Hard-fail the install
        // so the operator can investigate + retry.
        const detail = data.error || 'unknown error';
        await log(jobId, `❌ Reset failed: ${detail}. Aborting install — existing service data would persist and counted as already-installed in the next run. Fix the reset cause then retry.`);
        await patchJob(jobId, { phase: 'error', endedAt: new Date().toISOString(), error: `Reset failed: ${detail}` });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      await log(jobId, `❌ Reset call failed: ${msg}. Aborting install — clean-install was requested but the wipe didn't run. Check the server log and retry.`);
      await patchJob(jobId, { phase: 'error', endedAt: new Date().toISOString(), error: `Reset call failed: ${msg}` });
      return;
    }
  }

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
    } else {
      await log(jobId, '⚠️ Could not detect LAN IP (agent returned no `ip route get` result); diagnose probes that depend on it will degrade.');
    }
  } catch (e) {
    await log(jobId, `⚠️ LAN IP capture failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const checked = input.items.filter(i => i.checked);
  if (checked.length === 0) {
    await log(jobId, '⚠️ No services selected to install — aborting.');
    await patchJob(jobId, { phase: 'done', endedAt: new Date().toISOString(), credentialsManifest: [] });
    return;
  }

  // Topo-sort by install-time dependencies. We also tag each item
  // with its `servicebay.tier` so the sort adds an implicit edge from
  // every feature to every infrastructure item — guaranteeing the
  // whole infra block (nginx, auth, adguard, …) is fully deployed
  // before any feature can register against it (#796). Without that
  // gate, an unrelated feature with no declared deps (ollama, hermes)
  // races nginx and ends up registering NPM proxy hosts that the
  // late-running NPM credentials self-heal then wipes.
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
    { alreadyInstalled: new Set(input.items.filter(i => i.alreadyInstalled).map(i => i.name)) },
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

  const ctx: DeployContext = { jobId, input, scriptCredentials, deployed: [] };

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
  // Conditions for the override:
  //   - Not a clean install (always reuse saved state on plain re-install), OR
  //   - Clean install AND `secrets` is in the preserve list (operator
  //     explicitly chose to keep prior identity).
  //
  // The legacy NPM-specific block below is now subsumed by this general
  // path; kept anyway because it has a specific cert-archive-was-just-
  // restored log line that helps operators reason about what happened.
  // Names of secret-typed variables we reused from saved state. The
  // Authelia-storage self-heal below reads this to decide whether the
  // encryption key matches existing on-disk Authelia storage or is
  // freshly generated.
  const reusedSecretNames = new Set<string>();
  const shouldReuseSecrets = !input.cleanInstall || (input.preserve?.includes('secrets') ?? true);
  if (shouldReuseSecrets) {
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
  // with AUTHELIA_STORAGE_ENCRYPTION_KEY. If the wizard regenerates the
  // key (no saved value to reuse) but the preserved `authelia-data` dir
  // still holds rows encrypted with the previous install's key,
  // Authelia comes up returning 500 on every route — including the
  // readiness probe's OIDC discovery endpoint. Without intervention the
  // install times out 5 min later with no breadcrumb the operator can
  // act on.
  //
  // When we detect this case (auth is being deployed, AUTHELIA_STORAGE_
  // ENCRYPTION_KEY is *not* in the reused-from-saved set, and the data
  // dir has content), wipe `authelia-data/` only. LLDAP user accounts
  // at the sibling `auth/lldap` host path are preserved — that's the
  // identity state operators actually care about. The wizard's
  // post-deploy re-seeds Authelia's OIDC clients + storage schema from
  // scratch.
  const authIncluded = selected.some(s => s.name === 'auth' && !s.alreadyInstalled);
  if (authIncluded && !reusedSecretNames.has('AUTHELIA_STORAGE_ENCRYPTION_KEY')) {
    try {
      const { agentManager } = await import('@/lib/agent/manager');
      const { getConfig } = await import('@/lib/config');
      const cfg = await getConfig();
      const dataDir = cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
      const autheliaDataPath = `${dataDir}/auth/authelia-data`;
      const node = input.node || 'Local';
      const agent = await agentManager.ensureAgent(node);
      const probe = await agent.sendCommand('exec', {
        command: `[ -d "${autheliaDataPath}" ] && find "${autheliaDataPath}" -mindepth 1 -maxdepth 1 | head -1 || true`,
      });
      const hasContent = !!(probe.stdout || '').trim();
      if (hasContent) {
        await log(jobId, `🔄 Wiping Authelia storage at ${autheliaDataPath} — the encryption key is freshly generated and would mismatch the preserved storage (LLDAP users at ${dataDir}/auth/lldap are kept).`);
        await agent.sendCommand('exec', { command: `rm -rf "${autheliaDataPath}"` });
        await agent.sendCommand('exec', { command: `mkdir -p "${autheliaDataPath}" && chown core:core "${autheliaDataPath}"` });
        await log(jobId, `✅ Authelia storage cleared and recreated. Authelia will bootstrap fresh on first start.`);
      }
    } catch (e) {
      // Best-effort: if probe/wipe fails the install will hit the
      // readiness-probe 5-min timeout. Surface the recovery one-liner
      // so the operator can unstick themselves manually.
      const dataDirFallback = (await getConfig()).templateSettings?.DATA_DIR || '/mnt/data/stacks';
      await log(jobId, `(note) couldn't auto-clear Authelia storage: ${e instanceof Error ? e.message : String(e)}. If readiness times out, SSH to the node and \`rm -rf ${dataDirFallback}/auth/authelia-data\` before retrying.`);
    }
  }

  // LLDAP admin-password drift detection (#666). The pathological
  // combination is "wipe secrets, preserve identity": the wizard
  // generates a fresh LLDAP_ADMIN_PASSWORD, but the LLDAP image does
  // not rotate the admin password from env on subsequent starts — it
  // only does so on first DB init. So the operator can't log in with
  // the wizard's password, and the previous password is gone with the
  // wiped `secret.key`. Authelia self-heals by wiping its data dir
  // (#619); LLDAP can't because that would destroy *all* user accounts.
  //
  // Best we can do is detect the situation and log a clear breadcrumb
  // so the operator finds the recovery path (docs/CREDENTIAL_SELF_HEAL.md)
  // instead of silently getting locked out. No code action — the
  // recovery is operator-decision territory.
  if (authIncluded && !reusedSecretNames.has('LLDAP_ADMIN_PASSWORD')) {
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
        await log(jobId, `⚠️ LLDAP admin-password drift detected: existing users.db at ${lldapDbPath} won't accept the wizard's freshly-generated password. If you can't log in to LLDAP, see docs/CREDENTIAL_SELF_HEAL.md for the recovery path.`);
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

    // Self-heal on clean install with certs preserved (#704). The
    // operator's data volume kept the OLD admin bcrypt; the wizard's
    // INITIAL_ADMIN_PASSWORD env never overwrites an existing admin
    // user. The pre-fix flow paused for the operator to type the old
    // password — which they typically don't have (forgotten, never
    // copied off the credentials banner). Auto-wipe the NPM data dir
    // (admin sqlite + sites table) and retry bootstrap; letsencrypt/
    // stays untouched so cert files survive — that's the only reason
    // "preserve certs" exists in the first place.
    if (
      bootstrapState === 'needs_credentials'
      && input.cleanInstall
      && (input.preserve?.includes('certs') ?? true)
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

  // Build the final credentials manifest for the Done UI. Handler
  // already persisted per-template entries to `config.installManifest`
  // (credentials capability handler); this builds the JOB-STATE manifest
  // the wizard's Done step reads.
  const manifest = [
    ...buildCredentialsManifest({ variables, host: input.host }),
    ...scriptCredentials,
  ];
  await patchJob(jobId, { credentialsManifest: manifest });

  // Portal routing — apex + wildcard rewrites for the active domain.
  // Always runs after a successful install (#707). Pre-fix this was
  // gated on `adguard ∈ newlyDeployed`, which meant a feature-only
  // install (e.g. operator adds the `cloud` stack to an existing
  // host) silently skipped DNS-rewrite provisioning even though new
  // subdomains were being created. Now run it whenever the
  // prerequisites (publicDomain + AdGuard reachable) are met; the
  // provisioner internally no-ops when AdGuard isn't installed yet.
  await log(jobId, 'Provisioning AdGuard DNS rewrites + portal routing...');
  await provisionPortalWithRetries((line: string) => { void log(jobId, line); });

  // Settle-wait against the in-process digital twin.
  await settleWait(jobId, ctx.deployed, input.node || 'Local');

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
      pendingCredentials.delete(jobId);
    }
  })();
}
