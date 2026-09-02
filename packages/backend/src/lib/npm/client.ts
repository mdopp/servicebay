/**
 * The one place that knows where Nginx Proxy Manager's admin API is and
 * how to log in to it (#2730).
 *
 * Before this module, ten files carried their own copy of "find the nginx
 * service, derive the admin port, POST /api/tokens" — and the copies had
 * quietly diverged:
 *
 *   - the health probes ignored `service.active` (#496: for a kube-deployed
 *     pod the flag is unreliable, because the template's service name and
 *     the unit Quadlet generates don't line up — so trusting it produced
 *     false "not deployed" verdicts);
 *   - the diagnose probes, the re-key path and the API routes required it;
 *   - the routes cast `ports` to `{containerPort, hostPort}`, a shape
 *     `ServiceInfo.ports` (`{host, container}`) never has, so their
 *     "host port mapped to container 81" lookup was dead code and the
 *     config fallback always applied; the probes' "first host port that is
 *     not 80/443" heuristic is dead under `hostNetwork: true` (no host
 *     port is recorded at all), so they always fell back to 81.
 *
 * Merging them is a bugfix, not a tidy-up, so the divergence is made
 * explicit: `resolveNpmAdmin` takes `requireActive` and every caller states
 * which semantic it picked and why. Port derivation is the union of the
 * copies, in the order a real mapping beats a heuristic beats config:
 *
 *   1. the host port of the mapping whose container port is 81,
 *   2. the first host port that is not 80/443,
 *   3. `templateSettings.NGINX_ADMIN_PORT` (the operator's choice — nginx
 *      runs with hostNetwork, so this IS the listening port),
 *   4. 81.
 *
 * The API host is `127.0.0.1` for the Local node and the node's LAN IP
 * otherwise — the health probes used to hard-code `localhost`, which only
 * ever worked for Local.
 */
import { getConfig } from '../config';
import { ServiceManager } from '../services/ServiceManager';
import { getNodeIds, getNodeTwin } from '../store/repository';

/** Where NPM's admin API lives, plus what a proxy host must forward to. */
export interface NpmAdmin {
  /** Base URL of the admin API as reachable from the ServiceBay backend. */
  apiUrl: string;
  /** Node the NPM service runs on. */
  nodeName: string;
  /**
   * The node's LAN IP. NPM runs in its own pod, so a proxy host's
   * `forward_host` must be this address — never `127.0.0.1`, which from
   * inside NPM's netns is NPM itself.
   */
  nodeIp: string;
}

/**
 * Discriminated outcome of `resolveNpmAdmin`.
 *
 *   - `ok` — nginx found; admin URL derived.
 *   - `twin-not-ready` — no node had a populated digital twin yet
 *     (cold-start race: the health runner fires before the agent's first
 *     sync). Callers should report info and let the next tick self-correct
 *     rather than cementing a "not deployed" verdict.
 *   - `nginx-not-found` — the twin has data but no nginx service in it —
 *     the genuine "NPM not installed" case.
 *   - `nginx-inactive` — only with `requireActive`: nginx is installed but
 *     the twin reports the unit inactive on every candidate node.
 */
export type ResolveNpmResult =
  | ({ kind: 'ok' } & NpmAdmin)
  | { kind: 'twin-not-ready' }
  | { kind: 'nginx-not-found' }
  | { kind: 'nginx-inactive'; nodeName: string };

export interface ResolveNpmOptions {
  /** Look only on this node. Omitted: every node in the twin (`Local` if none). */
  node?: string;
  /**
   * Whether a twin entry with `active === false` counts as "no NPM here".
   * Read-only callers pass `false` and let the HTTP call be the source of
   * truth (#496); callers that mutate NPM or exec inside its container pass
   * `true`. Mandatory on purpose — there is no safe default.
   */
  requireActive: boolean;
}

/** Wizard defaults NPM ships with. Tried last by `getNpmToken`. */
export const NPM_DEFAULT_CREDENTIALS = { email: 'admin@example.com', password: 'changeme' } as const;

/** Matches the reverse-proxy service however the template named its unit
 *  (`nginx`, `nginx-web`, `nginx-pod`…) but never the one-shot
 *  `install-nginx` helper. */
function isNginxService(name: string): boolean {
  return name.includes('nginx') && !name.startsWith('install-');
}

function twinHasData(nodeName: string): boolean {
  const twin = getNodeTwin(nodeName);
  return !!twin && (twin.services.length > 0 || twin.containers.length > 0);
}

/** First non-loopback IP the twin knows for the node, else its first IP,
 *  else loopback. */
export function getNodeLanIp(nodeName: string): string {
  const twin = getNodeTwin(nodeName);
  if (twin?.nodeIPs?.length) {
    return twin.nodeIPs.find(ip => !ip.startsWith('127.')) ?? twin.nodeIPs[0];
  }
  return '127.0.0.1';
}

async function deriveAdminPort(ports: { host?: string; container: string }[] | undefined): Promise<string> {
  const mappings = ports ?? [];
  const byContainer = mappings.find(p => p.container === '81' && p.host && /^\d+$/.test(p.host));
  if (byContainer?.host) return byContainer.host;
  const heuristic = mappings
    .map(p => parseInt(String(p.host ?? ''), 10))
    .find(p => Number.isFinite(p) && p !== 80 && p !== 443);
  if (heuristic !== undefined) return String(heuristic);
  try {
    const config = await getConfig();
    const configured = config.templateSettings?.NGINX_ADMIN_PORT;
    if (configured && /^\d+$/.test(String(configured))) return String(configured);
  } catch {
    // config not ready — fall through to NPM's default
  }
  return '81';
}

/**
 * Locate NPM's admin API. Iterates the candidate nodes and returns the
 * first one that has a (matching, and with `requireActive` an active)
 * nginx service. Per-node failures (agent down, twin missing) never throw;
 * they simply disqualify that node.
 */
export async function resolveNpmAdmin(opts: ResolveNpmOptions): Promise<ResolveNpmResult> {
  const nodeNames = opts.node ? [opts.node] : getNodeIds();
  if (nodeNames.length === 0) nodeNames.push('Local');

  let sawTwinData = false;
  let inactiveOn: string | null = null;
  for (const nodeName of nodeNames) {
    let nginx: { name: string; active: boolean; ports?: { host?: string; container: string }[] } | undefined;
    try {
      const services = await ServiceManager.listServices(nodeName);
      nginx = services.find(s => isNginxService(s.name));
    } catch {
      continue;
    }
    if (!nginx) {
      // Twin emptiness is checked only once listing found nothing: a
      // service list that names nginx is proof enough that the node is
      // populated, whatever the twin's own counters say.
      if (twinHasData(nodeName)) sawTwinData = true;
      continue;
    }
    if (opts.requireActive && !nginx.active) {
      inactiveOn ??= nodeName;
      continue;
    }
    const adminPort = await deriveAdminPort(nginx.ports);
    const nodeIp = getNodeLanIp(nodeName);
    const apiHost = nodeName === 'Local' ? '127.0.0.1' : nodeIp;
    return { kind: 'ok', apiUrl: `http://${apiHost}:${adminPort}`, nodeName, nodeIp };
  }
  if (inactiveOn) return { kind: 'nginx-inactive', nodeName: inactiveOn };
  return sawTwinData ? { kind: 'nginx-not-found' } : { kind: 'twin-not-ready' };
}

/** `resolveNpmAdmin` for callers that only need "where, or nothing". */
export async function findNpmAdmin(opts: ResolveNpmOptions): Promise<NpmAdmin | null> {
  const r = await resolveNpmAdmin(opts);
  if (r.kind !== 'ok') return null;
  const { apiUrl, nodeName, nodeIp } = r;
  return { apiUrl, nodeName, nodeIp };
}

/** One login attempt with explicit credentials. `null` on any rejection or
 *  transport error — the bootstrap flow needs to tell "these creds don't
 *  work" apart from "some creds work", so this never falls back. */
export async function loginNpm(
  apiUrl: string,
  creds: { email: string; password: string },
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: creds.email, secret: creds.password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
    return typeof data?.token === 'string' ? data.token : null;
  } catch {
    return null;
  }
}

/**
 * Mint an admin bearer token. Candidates, in order:
 *   1. credentials the caller passed in (the wizard form),
 *   2. the stored ones (`config.reverseProxy.npm`),
 *   3. NPM's wizard defaults.
 * Returns `null` when none authenticates.
 */
export async function getNpmToken(
  apiUrl: string,
  provided?: { email: string; password: string },
): Promise<string | null> {
  const candidates: { email: string; password: string }[] = [];
  if (provided?.email && provided?.password) candidates.push(provided);
  try {
    const stored = (await getConfig()).reverseProxy?.npm;
    if (stored?.email && stored?.password) candidates.push({ email: stored.email, password: stored.password });
  } catch {
    // config not ready — defaults still get their turn
  }
  candidates.push(NPM_DEFAULT_CREDENTIALS);
  for (const cred of candidates) {
    const token = await loginNpm(apiUrl, cred);
    if (token) return token;
  }
  return null;
}
