/**
 * LAN→Public migration orchestrator (#265).
 *
 * Takes a `publicDomain`, plans (dry-run) or applies the additive
 * "soft handoff" migration locked in on the issue comment:
 *
 *   1. NPM proxy hosts: each existing host's `domain_names` becomes
 *      `[<sub>.<lanRoot>, <sub>.<publicDomain>]`. Forward host/port
 *      unchanged. Idempotent — hosts already carrying the public name
 *      are skipped.
 *   2. Authelia `configuration.yml`: session cookie domain flips to
 *      the public root (single non-additive change), `authelia_url`
 *      rewritten, access_control rule domains gain public-domain
 *      twins, OIDC client redirect_uris gain public-domain twins.
 *      Auth pod restarted to pick up the new config.
 *   3. Cert request: one Let's Encrypt cert per public-twin host via
 *      NPM's ACME endpoint, bound to the dual-server_name proxy host.
 *      Best-effort: a single failed cert doesn't abort — the operator
 *      retries via the diagnose `cert_request_failure` probe.
 *   4. Config: `reverseProxy.publicDomain` is set; the letsdebug +
 *      domain health checks are re-synced so newly-public hosts get
 *      external-reachability probes on the next tick.
 *
 * Re-running the orchestrator is safe and resumes from wherever the
 * previous run left off, per the locked design's "no transactional
 * rollback" decision.
 *
 * I/O lives in this file; the pure yaml rewrite lives in
 * `autheliaRewrite.ts` so the trickiest piece has its own unit-test
 * surface independent of network mocks.
 */

import { getConfig, updateConfig } from '../config';
import { DigitalTwinStore } from '../store/twin';
import { ServiceManager } from '../services/ServiceManager';
import { logger } from '../logger';
import yaml from 'js-yaml';
import { rewriteAutheliaConfig, type AutheliaRewriteChanges } from './autheliaRewrite';

const DEFAULT_LAN_ROOT = 'home.arpa';

// ─── Types ──────────────────────────────────────────────────────────

export interface MigrationOptions {
  publicDomain: string;
  /** When true, compute the plan but make no network or filesystem writes. */
  dryRun: boolean;
}

export interface ProxyHostStep {
  kind: 'npm-dual-server-name';
  hostId: number;
  domain: string;
  /** `domain_names` before the PUT (or after — see `skipped`). */
  before: string[];
  /** `domain_names` we would write. Equal to `before` when `skipped`. */
  after: string[];
  /** Already dual-server_name; no PUT needed. */
  skipped: boolean;
}

export interface AutheliaStep {
  kind: 'authelia-config';
  node: string;
  configPath: string;
  /** Summary of yaml-level changes. Empty fields mean "already migrated". */
  changes: AutheliaRewriteChanges;
  /** True when the rewrite would yield the same string we read. */
  noop: boolean;
}

export interface CertRequestStep {
  kind: 'cert-request';
  hostId: number;
  domain: string;
  /** Skipped when the proxy host already carries a non-zero certificate_id. */
  skipped: boolean;
  skipReason?: string;
}

export type MigrationStep = ProxyHostStep | AutheliaStep | CertRequestStep;

export interface MigrationPlan {
  publicDomain: string;
  lanRoot: string;
  /** Operator-visible warnings that don't block the run but should be surfaced. */
  warnings: string[];
  steps: MigrationStep[];
}

export interface MigrationApplyError {
  step: MigrationStep['kind'];
  detail: string;
  /** Domain or hostId where the error happened, when applicable. */
  target?: string;
}

export interface MigrationResult {
  plan: MigrationPlan;
  applied: boolean;
  errors: MigrationApplyError[];
  /**
   * Per-step outcomes, in plan order. Each entry is one of:
   *  - `{ ok: true }` for steps that ran (or were no-ops) cleanly.
   *  - `{ ok: false, error }` mirroring the matching `errors[]` entry.
   */
  stepResults: { ok: boolean; error?: string }[];
}

// ─── NPM helpers (slim, migration-scoped) ───────────────────────────

interface NpmTarget {
  apiUrl: string;
  nodeName: string;
  nodeIp: string;
}

interface NpmHost {
  id: number;
  domain_names: string[];
  forward_host?: string;
  forward_port?: number;
  forward_scheme?: string;
  certificate_id?: number;
  enabled?: boolean;
}

interface NpmDeps {
  resolveNpm(nodeHint?: string): Promise<NpmTarget | null>;
  getToken(baseUrl: string): Promise<string | null>;
  listHosts(baseUrl: string, token: string): Promise<NpmHost[]>;
  updateHost(baseUrl: string, token: string, id: number, patch: Partial<NpmHost>): Promise<void>;
  requestCert(baseUrl: string, token: string, domain: string): Promise<number>;
  bindCert(baseUrl: string, token: string, hostId: number, certId: number): Promise<void>;
}

/**
 * Lazy-loaded NPM bindings — kept behind a `deps` arg so tests can pass
 * an in-memory fake without touching `fetch`. The real implementation
 * mirrors the existing patterns in
 * `src/app/api/system/nginx/proxy-hosts/route.ts`.
 */
async function realNpmDeps(): Promise<NpmDeps> {
  return {
    resolveNpm: async (nodeHint) => {
      const twin = DigitalTwinStore.getInstance();
      const nodeNames = nodeHint ? [nodeHint] : Object.keys(twin.nodes);
      if (nodeNames.length === 0) nodeNames.push('Local');
      for (const nodeName of nodeNames) {
        const services = await ServiceManager.listServices(nodeName);
        const nginx = services.find(s => s.name === 'nginx' || (s.name.includes('nginx') && !s.name.startsWith('install-')));
        if (!nginx?.active) continue;
        const svc = nginx as { ports?: { containerPort?: number; hostPort?: number }[] };
        const adminMapping = svc.ports?.find(p => p.containerPort === 81);
        let adminPort = adminMapping?.hostPort?.toString();
        if (!adminPort) {
          const config = await getConfig();
          adminPort = config.templateSettings?.NGINX_ADMIN_PORT || '81';
        }
        const t = twin.nodes[nodeName];
        const nodeIp = t?.nodeIPs?.find(ip => !ip.startsWith('127.')) ?? t?.nodeIPs?.[0] ?? '127.0.0.1';
        const apiHost = nodeName === 'Local' ? '127.0.0.1' : nodeIp;
        return { apiUrl: `http://${apiHost}:${adminPort}`, nodeName, nodeIp };
      }
      return null;
    },
    getToken: async (baseUrl) => {
      const config = await getConfig();
      const candidates: { identity: string; secret: string }[] = [];
      const stored = config.reverseProxy?.npm;
      if (stored?.email && stored?.password) candidates.push({ identity: stored.email, secret: stored.password });
      candidates.push({ identity: 'admin@example.com', secret: 'changeme' });
      for (const cred of candidates) {
        try {
          const res = await fetch(`${baseUrl}/api/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cred),
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = await res.json() as { token?: string };
            if (data.token) return data.token;
          }
        } catch { /* try next */ }
      }
      return null;
    },
    listHosts: async (baseUrl, token) => {
      const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts?expand=owner,access_list,certificate`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`NPM list-hosts HTTP ${res.status}`);
      return (await res.json()) as NpmHost[];
    },
    updateHost: async (baseUrl, token, id, patch) => {
      const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`NPM update-host ${id} HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    },
    requestCert: async (baseUrl, token, domain) => {
      const res = await fetch(`${baseUrl}/api/nginx/certificates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          provider: 'letsencrypt',
          domain_names: [domain],
          meta: { dns_challenge: false },
        }),
        // ACME exchange blocks until LE either issues or times out; budget
        // generously per the existing proxy-hosts/route precedent.
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`NPM cert-request HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json() as { id?: number };
      if (typeof data.id !== 'number') {
        throw new Error('NPM accepted the cert request but returned no id.');
      }
      return data.id;
    },
    bindCert: async (baseUrl, token, hostId, certId) => {
      const res = await fetch(`${baseUrl}/api/nginx/proxy-hosts/${hostId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ certificate_id: certId, ssl_forced: true, http2_support: true, hsts_enabled: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`NPM cert-bind cert=${certId} host=${hostId} HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}

// ─── Authelia helpers ───────────────────────────────────────────────

interface AutheliaDeps {
  /** Locate the auth pod's `configuration.yml` on disk. */
  locateConfig(): Promise<{ node: string; path: string; content: string } | null>;
  /** Write the config back. */
  writeConfig(node: string, path: string, content: string): Promise<void>;
  /** Restart the auth pod so it re-reads the new config. */
  restartAuth(node: string): Promise<void>;
}

async function realAutheliaDeps(): Promise<AutheliaDeps> {
  const { agentManager } = await import('../agent/manager');
  return {
    locateConfig: async () => {
      const twin = DigitalTwinStore.getInstance();
      for (const nodeName of Object.keys(twin.nodes)) {
        try {
          const files = await ServiceManager.getServiceFiles(nodeName, 'auth');
          if (!files.yamlContent) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const docs = yaml.loadAll(files.yamlContent) as any[];
          let configHostPath = '';
          for (const doc of docs) {
            const volumes = doc?.spec?.volumes;
            if (!Array.isArray(volumes)) continue;
            for (const vol of volumes) {
              if (vol.name?.includes('config') && vol.hostPath?.path) {
                configHostPath = vol.hostPath.path;
                break;
              }
            }
            if (configHostPath) break;
          }
          if (!configHostPath) continue;
          const configFilePath = `${configHostPath}/configuration.yml`;
          const agent = await agentManager.ensureAgent(nodeName);
          const readRes = await agent.sendCommand('read_file', { path: configFilePath });
          const content = readRes.content || readRes.stdout || '';
          if (!content) continue;
          return { node: nodeName, path: configFilePath, content };
        } catch {
          // Authelia not on this node — try the next.
        }
      }
      return null;
    },
    writeConfig: async (node, path, content) => {
      const agent = await agentManager.ensureAgent(node);
      await agent.sendCommand('write_file', { path, content });
    },
    restartAuth: async (node) => {
      // Restarting the merged `auth` pod restarts authelia + lldap together —
      // same trade-off the existing oidc-clients route accepts. Fast (<5s)
      // and lldap re-attaches cleanly.
      await ServiceManager.restartService(node, 'auth');
    },
  };
}

// ─── Health-check refresh hook ──────────────────────────────────────

interface HealthDeps {
  /** Resync letsdebug + domain checks for the newly-public host list. */
  syncChecks(): Promise<void>;
}

async function realHealthDeps(): Promise<HealthDeps> {
  return {
    syncChecks: async () => {
      try {
        const { syncDomainChecks } = await import('../health/domainChecks');
        const { syncLetsdebugChecks } = await import('../health/letsdebugChecks');
        await syncDomainChecks();
        await syncLetsdebugChecks();
      } catch (e) {
        logger.warn('migrate-to-public', `Health-check resync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ─── DI shape for tests ─────────────────────────────────────────────

export interface MigrationDeps {
  npm: NpmDeps;
  authelia: AutheliaDeps;
  health: HealthDeps;
}

/**
 * Public-domain twin of a lan-rooted hostname. Returns `null` for
 * anything not on the lan root (so already-public hosts are left
 * alone by the migration loop).
 */
function publicTwin(domain: string, lanRoot: string, publicDomain: string): string | null {
  const lc = domain.toLowerCase();
  const root = lanRoot.toLowerCase();
  if (lc === root) return publicDomain;
  if (lc.endsWith(`.${root}`)) {
    const sub = domain.slice(0, domain.length - root.length - 1);
    return `${sub}.${publicDomain}`;
  }
  return null;
}

// ─── Public entry points ────────────────────────────────────────────

/**
 * Validate a `publicDomain` against the same hostname-shaped pattern
 * the mode-classifier endpoint uses. Returns `null` when the domain
 * is acceptable, or a human-readable error message otherwise.
 */
export function validatePublicDomain(input: unknown): string | null {
  if (typeof input !== 'string') return 'publicDomain must be a string';
  const trimmed = input.trim();
  if (!trimmed) return 'publicDomain is required';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(trimmed)) {
    return 'publicDomain must be a valid hostname (e.g. example.com).';
  }
  return null;
}

/**
 * Build a plan against the current install state without making any
 * changes. Safe to call repeatedly; output is deterministic given the
 * same inputs.
 */
export async function planMigrationToPublic(
  options: MigrationOptions,
  depsOverride?: Partial<MigrationDeps>,
): Promise<MigrationPlan> {
  const publicDomain = options.publicDomain.trim();
  const config = await getConfig();
  const lanRoot = (config.reverseProxy?.lanDomain || DEFAULT_LAN_ROOT).trim();

  const warnings: string[] = [];
  const steps: MigrationStep[] = [];

  // The orchestrator is only meaningful in lan→public; if a public domain
  // is already set, surface a warning and re-plan against the *new* domain
  // so re-runs after a partial apply still converge.
  if (config.reverseProxy?.publicDomain && config.reverseProxy.publicDomain !== publicDomain) {
    warnings.push(
      `reverseProxy.publicDomain is already set to '${config.reverseProxy.publicDomain}'; planning against '${publicDomain}' will add a parallel public domain rather than replace it.`,
    );
  }

  const deps: MigrationDeps = {
    npm: depsOverride?.npm ?? (await realNpmDeps()),
    authelia: depsOverride?.authelia ?? (await realAutheliaDeps()),
    health: depsOverride?.health ?? (await realHealthDeps()),
  };

  // 1) NPM proxy hosts — list, then per-host twin plan. Hosts are
  //    iterated once and contribute both a dual-server_name step and
  //    a (conditional) cert-request step so the per-host certificate
  //    state can be read off the same record.
  const npmTarget = await deps.npm.resolveNpm();
  const certSteps: CertRequestStep[] = [];
  if (!npmTarget) {
    warnings.push('Nginx Proxy Manager is not deployed or not running; proxy-host steps will be skipped.');
  } else {
    const token = await deps.npm.getToken(npmTarget.apiUrl);
    if (!token) {
      warnings.push(`Could not authenticate with NPM at ${npmTarget.apiUrl}; proxy-host steps will be skipped.`);
    } else {
      let hosts: NpmHost[] = [];
      try {
        hosts = await deps.npm.listHosts(npmTarget.apiUrl, token);
      } catch (e) {
        warnings.push(`Could not list NPM proxy hosts: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const host of hosts) {
        const lanEntry = (host.domain_names ?? []).find(d => publicTwin(d, lanRoot, publicDomain) !== null);
        if (!lanEntry) continue;
        const twin = publicTwin(lanEntry, lanRoot, publicDomain);
        if (!twin) continue;
        const before = (host.domain_names ?? []).slice();
        const alreadyDual = before.includes(twin);
        const after = alreadyDual ? before : [...before, twin];
        steps.push({
          kind: 'npm-dual-server-name',
          hostId: host.id,
          domain: lanEntry,
          before,
          after,
          skipped: alreadyDual,
        });
        const hasCert = typeof host.certificate_id === 'number' && host.certificate_id > 0;
        certSteps.push({
          kind: 'cert-request',
          hostId: host.id,
          domain: twin,
          skipped: hasCert,
          skipReason: hasCert
            ? `host ${host.id} already has certificate_id=${host.certificate_id}`
            : undefined,
        });
      }
    }
  }

  // 2) Authelia config — read + dry-run the rewrite to surface changes.
  const autheliaLoc = await deps.authelia.locateConfig();
  if (!autheliaLoc) {
    warnings.push('Authelia (auth pod) is not deployed; SSO migration step will be skipped.');
  } else {
    const result = rewriteAutheliaConfig(autheliaLoc.content, lanRoot, publicDomain);
    const noop = result.yaml === autheliaLoc.content;
    steps.push({
      kind: 'authelia-config',
      node: autheliaLoc.node,
      configPath: autheliaLoc.path,
      changes: result.changes,
      noop,
    });
  }

  // 3) Cert requests collected alongside the dual-server_name loop;
  //    append them after the Authelia step so the order is
  //    NPM-rewrite → Authelia → cert. Cert issuance depends on the
  //    proxy host serving on port 80 with the new server_name, which
  //    only holds true once step 1 has run.
  steps.push(...certSteps);

  return { publicDomain, lanRoot, warnings, steps };
}

/**
 * Plan + apply. Each step's failure lands as a `MigrationApplyError`
 * but does not abort subsequent steps — the design's "idempotent +
 * retryable, no rollback" contract means a re-run picks up exactly
 * the steps that failed.
 */
export async function applyMigrationToPublic(
  options: MigrationOptions,
  depsOverride?: Partial<MigrationDeps>,
): Promise<MigrationResult> {
  const deps: MigrationDeps = {
    npm: depsOverride?.npm ?? (await realNpmDeps()),
    authelia: depsOverride?.authelia ?? (await realAutheliaDeps()),
    health: depsOverride?.health ?? (await realHealthDeps()),
  };

  const plan = await planMigrationToPublic(options, deps);
  if (options.dryRun) {
    // Dry-run never touches anything; report all steps as ok.
    return {
      plan,
      applied: false,
      errors: [],
      stepResults: plan.steps.map(() => ({ ok: true })),
    };
  }

  const errors: MigrationApplyError[] = [];
  const stepResults: { ok: boolean; error?: string }[] = [];

  // Resolve NPM once for the apply pass — same target the plan saw.
  const npmTarget = await deps.npm.resolveNpm();
  const npmToken = npmTarget ? await deps.npm.getToken(npmTarget.apiUrl) : null;

  for (const step of plan.steps) {
    try {
      if (step.kind === 'npm-dual-server-name') {
        if (step.skipped) {
          stepResults.push({ ok: true });
          continue;
        }
        if (!npmTarget || !npmToken) {
          throw new Error('NPM not reachable; cannot dual server_name.');
        }
        await deps.npm.updateHost(npmTarget.apiUrl, npmToken, step.hostId, {
          domain_names: step.after,
        });
        stepResults.push({ ok: true });
        continue;
      }

      if (step.kind === 'authelia-config') {
        if (step.noop) {
          stepResults.push({ ok: true });
          continue;
        }
        // Re-read + re-rewrite right before write to avoid TOCTOU on a
        // config someone edited between plan and apply.
        const loc = await deps.authelia.locateConfig();
        if (!loc) throw new Error('Authelia config disappeared between plan and apply.');
        const result = rewriteAutheliaConfig(loc.content, plan.lanRoot, plan.publicDomain);
        if (result.yaml !== loc.content) {
          await deps.authelia.writeConfig(loc.node, loc.path, result.yaml);
          await deps.authelia.restartAuth(loc.node);
        }
        stepResults.push({ ok: true });
        continue;
      }

      if (step.kind === 'cert-request') {
        if (step.skipped) {
          stepResults.push({ ok: true });
          continue;
        }
        if (!npmTarget || !npmToken) {
          throw new Error('NPM not reachable; cannot request cert.');
        }
        const certId = await deps.npm.requestCert(npmTarget.apiUrl, npmToken, step.domain);
        await deps.npm.bindCert(npmTarget.apiUrl, npmToken, step.hostId, certId);
        stepResults.push({ ok: true });
        continue;
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const target = 'domain' in step ? step.domain : ('node' in step ? step.node : undefined);
      errors.push({ step: step.kind, detail, target });
      stepResults.push({ ok: false, error: detail });
      logger.warn('migrate-to-public', `Step ${step.kind} failed: ${detail}`);
    }
  }

  // Persist the new public domain + refresh proxy host entries so the
  // letsdebug + domain checks pick up the new public-twin domains on
  // their next tick. We do this even when some steps errored — the
  // operator's recovery path is re-running the migration, which is
  // idempotent.
  try {
    const config = await getConfig();
    const existingHosts = config.reverseProxy?.hosts ?? [];
    const newHostEntries = existingHosts.flatMap(entry => {
      const twin = publicTwin(entry.domain, plan.lanRoot, plan.publicDomain);
      if (!twin) return [entry];
      const alreadyPresent = existingHosts.some(h => h.domain === twin);
      if (alreadyPresent) return [entry];
      return [
        entry,
        { ...entry, domain: twin, exposure: 'public' as const },
      ];
    });
    await updateConfig({
      reverseProxy: {
        ...config.reverseProxy,
        publicDomain: plan.publicDomain,
        hosts: newHostEntries,
      },
    });
    await deps.health.syncChecks();
  } catch (e) {
    const detail = `Post-apply config persistence failed: ${e instanceof Error ? e.message : String(e)}`;
    errors.push({ step: 'authelia-config', detail });
    logger.warn('migrate-to-public', detail);
  }

  return {
    plan,
    applied: true,
    errors,
    stepResults,
  };
}
