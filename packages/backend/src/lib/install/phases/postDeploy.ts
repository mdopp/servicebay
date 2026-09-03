/**
 * Post-deploy — everything that runs once the pods are on the box (#2742 —
 * split out of `runner.ts`).
 *
 * Register the new services with the health poller, bootstrap/heal the NPM
 * admin login, fire each template's `feature.installed` capability event,
 * guarantee the proxy hosts / OIDC clients / Hermes key that the per-template
 * emits may have missed, build and persist the credentials manifest, wait for
 * the stack to settle, then provision portal routing and re-point the box's
 * own resolver.
 *
 * Only one step can end the run: the NPM credentials prompt, which the
 * operator may abort. That is reported back as `{ aborted: true }` — the
 * runner owns the job status, this phase does not patch it.
 */
import { getCapabilityBus } from '@/lib/capabilities/bus';
import { getConfig, saveConfig, type InstalledCredential } from '@/lib/config';
import { getTemplateYaml } from '@/lib/registry';
import { npmAdminCredStatus, rekeyNpmAdmin } from '@/lib/reverseProxy/npmAdminRekey';
import { parseTemplateManifest } from '@/lib/template/contract';
import { buildCredentialsManifest, mergeCredentials, type Credential } from '@/lib/stackInstall/credentialsManifest';
import { provisionPortalWithRetries } from '@/lib/stackInstall/portalProvision';
import { bootstrapNpmAdmin, type StackVariable } from '@/lib/stackInstall/postInstall';
import { waitForCredentials as waitForCredentialsResolve } from '../credentialResolver';
import { recordHandlerFailure, emitFeatureInstalledWithRetry, MAX_EMIT_ATTEMPTS } from '../handlerFailures';
import { ensureProxyHosts, ensureOidcClients, ensureHermesApiKey } from '../postInstallDispatcher';
import {
  apiFetch,
  appendJobWarning,
  isJobAborted,
  log,
  patchJob,
  type DeployContext,
} from './context';
import { settleWait } from './readiness';

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

/** Register newly-deployed services with the health poller (#627).
 *  The bootstrap walks every service in the twin and registers each
 *  one whose template ships a `servicebay.healthcheck` annotation;
 *  the poller's register() fires an immediate probe so the settle-wait
 *  sees `twin.health.ready` populate within seconds, not on the next
 *  30s tick. */
async function bootstrapHealth(jobId: string, node: string): Promise<void> {
  try {
    const { bootstrapServiceHealth } = await import('@/lib/health/serviceHealthBootstrap');
    await bootstrapServiceHealth(node);
  } catch (e) {
    await log(jobId, `(note) couldn't refresh service-health registrations: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Self-heal whenever NPM rejects every credential we know about (#704). The
 * operator's data volume kept the OLD admin bcrypt; the wizard's
 * INITIAL_ADMIN_PASSWORD env never overwrites an existing admin user. The
 * pre-fix flow paused for the operator to type the old password — which they
 * typically don't have (forgotten, never copied off the credentials banner).
 * Auto-wipe the NPM data dir (admin sqlite + sites table) and retry bootstrap;
 * letsencrypt/ stays untouched so cert files survive — the heal targets only
 * the stale admin DB, never the certs.
 *
 * #1585 — re-expressed against the wipeMode model's data-keep semantics. The
 * heal is intrinsically cert-preserving (it removes only
 * `nginx-proxy-manager/data`, leaving `letsencrypt/`), so it applies for any
 * mode that keeps NPM's certs on disk: `install` and `wipe-config`. On
 * `wipe-all` the whole NPM dir was already cleared by the per-service wipe, so
 * there's no stale admin DB to heal — the caller skips this.
 *
 * Returns true when the retry bootstrapped cleanly.
 */
async function healStaleNpmAdminDb(ctx: DeployContext, variables: StackVariable[]): Promise<boolean> {
  const { jobId, input } = ctx;
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
    if (retry === 'ok') return true;
    await log(jobId, '⚠️ NPM still rejecting credentials after data-wipe retry; falling back to the credentials prompt.');
  } catch (e) {
    await log(jobId, `⚠️ NPM self-heal failed (${e instanceof Error ? e.message : String(e)}); falling back to the credentials prompt.`);
  }
  return false;
}

/**
 * NPM bootstrap (seeds admin creds). #632 moved the bulk proxy-host /
 * OIDC-client / DNS-rewrite / credentials-manifest work to capability
 * handlers; this only handles the operator-interactive NPM credentials
 * prompt that doesn't fit the bus pattern.
 *
 * Returns true when the operator aborted at the prompt.
 */
async function bootstrapNpm(ctx: DeployContext, variables: StackVariable[]): Promise<boolean> {
  const { jobId, input } = ctx;
  let bootstrapState: 'ok' | 'needs_credentials' | 'skipped' = await bootstrapNpmAdmin({
    variables,
    node: input.node || undefined,
    onLog: (line: string) => { void log(jobId, line); },
  });

  if (bootstrapState === 'needs_credentials' && input.wipeMode !== 'wipe-all') {
    if (await healStaleNpmAdminDb(ctx, variables)) bootstrapState = 'ok';
  }

  if (bootstrapState !== 'needs_credentials') return false;

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
  if (isJobAborted(jobId)) return true;
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
  return false;
}

/** Per-template capability events (#632). Each newly-deployed template
 *  fires `feature.installed`; subscribed handlers (Authelia OIDC, NPM
 *  proxy hosts, AdGuard DNS, credentials manifest) do their cross-
 *  service registration. Handlers are idempotent — re-emitting is safe. */
async function emitCapabilityEvents(
  ctx: DeployContext,
  newlyDeployed: Set<string>,
  variables: StackVariable[],
): Promise<void> {
  const { jobId, input } = ctx;
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
      // Bounded retry of RETRYABLE handler failures (#2160). Covers the
      // Authelia `retryable: true` OIDC-registration races (auth pod
      // restarting mid-install) that were previously dropped. Retry policy
      // lives in `emitFeatureInstalledWithRetry`.
      const result = await emitFeatureInstalledWithRetry({
        emit: () =>
          bus.emit({
            kind: 'feature.installed',
            template: name,
            manifest: parsed.manifest,
            variables,
          }),
        onRetry: (attempt, count) =>
          log(jobId, `↻ Retrying ${count} recoverable handler failure(s) for ${name} (attempt ${attempt + 1}/${MAX_EMIT_ATTEMPTS})…`),
      });
      for (const f of result.failures) {
        if (f.result.ok) continue;
        // A failure that survived bounded retries (or was never retryable)
        // leaves this service in a silent half-state. Mark the install
        // non-green and persist a standing diagnose finding with a
        // reconcile action — don't just log-and-forget (#2160).
        await log(jobId, `⚠️ ${f.handler} (${name}): ${f.result.message} — capability registration did NOT complete; SSO/proxy for this service may be dead until reconciled.`);
        await appendJobWarning(jobId, `${name}: ${f.handler} — ${f.result.message}`);
        await recordHandlerFailure({
          kind: 'capability',
          service: name,
          message: `${f.handler}: ${f.result.message}`,
        });
      }
    } catch (e) {
      await log(jobId, `(note) capability emit failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** NPM admin self-heal (#1268, credential-reconciliation ARCH-15) — must run
 *  BEFORE proxy-host + portal provisioning (both need a working NPM admin
 *  login) and on EVERY install, not just when nginx is freshly installed.
 *  The failing case (#1268): a new stack with an internal subdomain installed
 *  onto a box whose nginx was already present with an empty/diverged NPM
 *  password — the old gate (fresh-nginx only, and positioned after this step)
 *  skipped the heal, so per-service proxy hosts + portal routing failed with
 *  no recovery on every (re)install. npmAdminCredStatus self-skips ('unknown')
 *  when NPM isn't reachable, so this is a cheap no-op for NPM-less installs.
 *  Best-effort; never fatal (the npm_data_stale diagnose action is the manual
 *  fallback). rekeyNpmAdmin writes NPM's admin hash directly, so it recovers
 *  even when ServiceBay's stored password is empty. */
async function healNpmAdmin(jobId: string, node: string): Promise<void> {
  try {
    const status = await npmAdminCredStatus(node);
    if (status === 'rejected' || status === 'no-creds') {
      await log(jobId, '🔑 NPM is rejecting/missing the stored admin credentials — re-keying in place (proxy routes preserved)…');
      const r = await rekeyNpmAdmin(node);
      await log(jobId, (r.ok ? '✅ ' : '⚠️ ') + r.message);
    }
  } catch (e) {
    await log(jobId, `(note) NPM admin reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Build the final credentials manifest for the Done UI and persist it to
 *  `config.installManifest` — the store the Settings → Saved Credentials page
 *  reads. The per-template credentials capability handler only emits OIDC
 *  client_secrets, so without this end-of-job write the post-deploy service
 *  logins (LLDAP, NPM, AdGuard, Jellyfin, Samba, …) never reach the persistent
 *  store and the page shows empty. Merged per-template so a feature-only
 *  install doesn't drop credentials from earlier installs. */
async function persistCredentialsManifest(ctx: DeployContext, variables: StackVariable[]): Promise<void> {
  const { jobId, input } = ctx;
  const manifest = [
    ...buildCredentialsManifest({ variables, host: input.host }),
    ...ctx.scriptCredentials,
  ];
  await patchJob(jobId, { credentialsManifest: manifest });

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
    // #2560 — an install started over MCP or REST has no browser, so the
    // blocking hand-over window reaches nobody. ServiceBay therefore keeps
    // its copy (deleting it unseen would be strictly worse) and says so
    // here, in the one place a headless caller does read. The hand-over
    // itself happens the next time a human opens ServiceBay — the gate in
    // the dashboard layout is driven by "does the box still hold
    // passwords?", not by "did an install just finish in this tab?".
    if (manifest.length > 0) {
      await log(
        jobId,
        `${manifest.length} password(s) exist only on this box. Open ServiceBay in a browser to download them — ` +
        'it will ask before you can do anything else, and it deletes its copy once the file has reached you.',
      );
    }
  } catch (e) {
    await log(jobId, `(note) couldn't persist the credentials manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** #1675 — now that AdGuard is up, re-point the BOX's own resolver at it
 *  (127.0.0.1) with the router as fallback and NO public 8.8.8.8. The
 *  install baked a public fallback for bootstrap (before AdGuard existed);
 *  leaving it in place lets the box resolve `*.<publicDomain>` to the
 *  PUBLIC IP, the #1559 trap one layer down. Best-effort: a failure logs
 *  and never fails the install. */
async function repointBoxResolver(jobId: string, node: string): Promise<void> {
  try {
    const { repointBoxResolverToAdguard } = await import('@/lib/router/boxResolverDns');
    const dnsResult = await repointBoxResolverToAdguard(node);
    if (dnsResult.result === 'ok') {
      await log(jobId, `✅ ${dnsResult.detail}`);
    } else {
      await log(jobId, `(note) box resolver re-point skipped/failed: ${dnsResult.detail}`);
    }
  } catch (e) {
    await log(jobId, `(note) box resolver re-point failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Run the whole post-deploy phase. `aborted` is true only when the operator
 *  cancelled at the NPM credentials prompt. */
export async function runPostDeployPhase(ctx: DeployContext): Promise<{ aborted: boolean }> {
  const { jobId, input } = ctx;
  const node = input.node || 'Local';

  await bootstrapHealth(jobId, node);

  const variables = input.variables as StackVariable[];
  const newlyDeployed = new Set(ctx.deployed.map(d => d.name).filter(name => {
    const item = input.items.find(i => i.name === name);
    return item && !item.alreadyInstalled;
  }));

  if (newlyDeployed.has('nginx')) {
    if (await bootstrapNpm(ctx, variables)) return { aborted: true };
  }

  await emitCapabilityEvents(ctx, newlyDeployed, variables);
  await healNpmAdmin(jobId, node);

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

  await persistCredentialsManifest(ctx, variables);

  // Settle-wait against the in-process digital twin FIRST, so the
  // services portal routing depends on (nginx, AdGuard) are actually
  // active — and AdGuard's post-deploy hook has had a chance to write
  // its admin creds — before we try to provision. Running portal
  // provisioning ahead of this fired it against not-yet-healthy
  // containers, which on a fresh install reported a misleading failure
  // (the proxy/DNS *were* being installed, just not up yet).
  await settleWait(jobId, ctx.deployed, node);

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

  await repointBoxResolver(jobId, node);

  return { aborted: false };
}
