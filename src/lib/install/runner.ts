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
import {
  fetchTemplatePostDeployScript,
  fetchTemplateMigrationScripts,
} from '@/app/actions';
import { parseTemplateSchemaVersion } from '@/lib/templateSchemaVersion';
import { topoSortByDependencies } from '@/lib/stackInstall/dependencies';
import { selectMigrationChain } from '@/lib/stackInstall/migrations';
import {
  runPostInstall,
  configureProxyRoutes,
  type StackVariable,
} from '@/lib/stackInstall/postInstall';
import { buildCredentialsManifest, type Credential } from '@/lib/stackInstall/credentialsManifest';
import { provisionPortalWithRetries } from '@/lib/stackInstall/portalProvision';
import { DigitalTwinStore } from '@/lib/store/twin';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { getConfig } from '@/lib/config';
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

/** Settle-wait: poll the digital twin in-process until every newly
 *  deployed service shows up as active. The browser version of this
 *  used to receive twin snapshots over Socket.IO; server-side we read
 *  the singleton directly, which is both simpler and authoritative. */
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
    const ready = expected.filter(name =>
      services.some(s => (s.name === name || s.name === `${name}.service`) && s.active),
    ).length;
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

/** Cross-template OIDC client registration. One POST collects every
 *  checked template's clients in a single call. */
async function registerOidcClients(
  jobId: string,
  checkedItems: JobInputItem[],
  vars: StackVariable[],
  templateSource: string,
): Promise<void> {
  if (!vars.find(v => v.name === 'PUBLIC_DOMAIN')?.value) return;
  const hasOidcClients = vars.some(v => v.meta?.oidcClient && v.meta?.type === 'subdomain' && v.value);
  if (!hasOidcClients) return;

  await log(jobId, 'Registering OIDC clients with Authelia...');
  const variableValues = vars.reduce<Record<string, string>>((acc, v) => {
    acc[v.name] = v.value;
    return acc;
  }, {});
  try {
    const res = await apiFetch('/api/system/authelia/oidc-clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templates: checkedItems.map(i => ({ name: i.name, source: templateSource })),
        variables: variableValues,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (data.added?.length) await log(jobId, `✅ OIDC clients registered: ${data.added.join(', ')}`);
      if (data.skipped?.length) await log(jobId, `ℹ️ Already registered: ${data.skipped.join(', ')}`);
    } else if (res.status === 404) {
      await log(jobId, '⚠️ Authelia not deployed — OIDC clients not registered. Deploy Authelia first, then redeploy this service.');
    } else {
      await log(jobId, `⚠️ Could not register OIDC clients: ${data.error || 'unknown error'}`);
    }
  } catch {
    await log(jobId, '⚠️ Could not reach Authelia. Register OIDC clients manually.');
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
    const raw = await fetchTemplatePostDeployScript(item.name, input.templateSource);
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
        const scripts = await fetchTemplateMigrationScripts(item.name, input.templateSource);
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

  // LAN_IP — the address rootless podman actually port-forwards to. With
  // `hostNetwork: true` on a rootless pod, ports inside the container's
  // namespace (e.g. immich-server binding [::1]:2283) are NOT visible on
  // the host's main loopback; podman only publishes them on the LAN IP.
  // Templates that need to HTTP-probe their own service from the host
  // post-deploy shell should prefer LAN_IP over 127.0.0.1 / [::1].
  // See templates/immich/post-deploy.py for the canonical use site.
  try {
    const config = await getConfig();
    const lanIp = config.reverseProxy?.lanIp;
    if (lanIp) postDeployEnv.LAN_IP = lanIp;
  } catch { /* best-effort — missing LAN_IP just means templates fall back to loopback */ }

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
    await log(jobId, '🧹 Clean install — wiping existing service data...');
    try {
      const res = await apiFetch('/api/system/stacks/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET', node: input.node || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        const removed = data.deleted?.length ?? 0;
        await log(jobId, `✅ Reset done — removed ${removed} service${removed === 1 ? '' : 's'}, wiped ${data.dataDir}.`);
        if (data.failed?.length) {
          await log(jobId, `⚠️ Some services could not be cleanly removed: ${data.failed.map((f: { name: string }) => f.name).join(', ')}`);
        }
      } else {
        await log(jobId, `⚠️ Reset failed: ${data.error || 'unknown error'}. Continuing with install — existing data may remain.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      await log(jobId, `⚠️ Reset call failed: ${msg}. Continuing with install.`);
    }
  }

  const checked = input.items.filter(i => i.checked);
  if (checked.length === 0) {
    await log(jobId, '⚠️ No services selected to install — aborting.');
    await patchJob(jobId, { phase: 'done', endedAt: new Date().toISOString(), credentialsManifest: [] });
    return;
  }

  // Topo-sort by install-time dependencies.
  const sortResult = topoSortByDependencies(
    checked.map(i => ({
      name: i.name,
      checked: i.checked,
      alreadyInstalled: i.alreadyInstalled,
      yaml: i.yaml,
      configFiles: i.configFiles,
      dependencies: i.dependencies ?? [],
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
    try {
      const ok = await deployItem(ctx, item);
      if (ok) ctx.deployed.push({ name: item.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await patchJob(jobId, { phase: 'error', endedAt: new Date().toISOString(), error: msg });
      return;
    }
  }

  // Post-install — NPM bootstrap + proxy hosts.
  const variables = input.variables as StackVariable[];
  const proxyResult = await runPostInstall({
    selected: ctx.deployed.map(d => ({ name: d.name, checked: true })),
    variables,
    node: input.node || undefined,
    onLog: (line: string) => { void log(jobId, line); },
    extraCredentials: scriptCredentials,
  });

  await registerOidcClients(jobId, input.items.filter(i => i.checked), variables, input.templateSource);

  // Build the final credentials manifest now so the Done UI has it as
  // soon as the job lands in `done`.
  const manifest = [
    ...buildCredentialsManifest({ variables, host: input.host }),
    ...scriptCredentials,
  ];
  await patchJob(jobId, { credentialsManifest: manifest });

  // NPM credentials prompt (mid-flow user input). Pause here until the
  // operator submits or skips.
  if (proxyResult === 'needs_credentials') {
    const fallback = {
      email: variables.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value ?? '',
      password: variables.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value ?? '',
    };
    const creds = await waitForCredentials(jobId, fallback);
    if (abortFlags.get(jobId)) {
      await patchJob(jobId, { phase: 'aborted', endedAt: new Date().toISOString() });
      return;
    }
    if (creds) {
      await log(jobId, 'Retrying with provided credentials...');
      await patchJob(jobId, { phase: 'running', needsCredentials: undefined });
      const retry = await configureProxyRoutes({
        variables,
        node: input.node || undefined,
        onLog: (line: string) => { void log(jobId, line); },
        credentials: creds,
        skipWait: true,
      });
      if (retry === 'needs_credentials') {
        await log(jobId, '❌ Authentication failed. Please check your credentials.');
        // Re-pause for another attempt.
        const second = await waitForCredentials(jobId, fallback);
        if (!second) {
          await patchJob(jobId, { phase: 'running', needsCredentials: undefined });
        } else {
          await configureProxyRoutes({
            variables,
            node: input.node || undefined,
            onLog: (line: string) => { void log(jobId, line); },
            credentials: second,
            skipWait: true,
          });
          await apiFetch('/api/system/nginx/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(second),
          }).catch(() => undefined);
        }
      } else {
        await apiFetch('/api/system/nginx/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(creds),
        }).catch(() => undefined);
        await log(jobId, 'Saved NPM credentials for future installs.');
      }
    } else {
      await log(jobId, 'NPM credentials skipped — proxy routes were not configured.');
      await patchJob(jobId, { phase: 'running', needsCredentials: undefined });
    }
  }

  // Portal routing — only meaningful when AdGuard is in the stack.
  if (ctx.deployed.some(d => d.name === 'adguard')) {
    await log(jobId, 'Provisioning AdGuard DNS rewrites + portal routing...');
    await provisionPortalWithRetries((line: string) => { void log(jobId, line); });
  }

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
