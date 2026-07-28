/**
 * Structural service attribution for health checks (#2394) — the second
 * half of #2080.
 *
 * #2080 made per-service attribution *structural* instead of substring
 * guessing, and gave everything it could not attribute an honest
 * "Box-wide" home. It left two whole classes stranded there:
 *
 *   1. `domain:*` checks — hard-classified box-wide because their `target`
 *      is a bare hostname that never equals a service name, even though
 *      the domain maps 1:1 to the service NPM forwards it to.
 *   2. the synthetic `diagnose:<probeId>` rows whose per-item findings
 *      name a specific container / unit / service (`crash_loop`,
 *      `failed_units`, `post_deploy_failed`).
 *
 * Both are resolvable from data the digital twin already carries, so this
 * module follows #2080's mechanism verbatim: the **backend stamps** the
 * structural identity (`Check.serviceName`, next to `Check.boxWide`) and
 * the frontend consumes it structurally — it never re-derives ownership by
 * matching strings in the browser.
 *
 * Deliberately NOT attributed (they monitor the node, not a stack, and the
 * box-wide section is where they belong): DNS/TLS infrastructure
 * (`dns_routing`, `cert_expiry`, `domain_resolves_to_box`), the agent /
 * gateway singletons, USB serial, `/mnt/data` storage.
 */

import { getContainers, getServices } from '@/lib/store/repository';

/** Strip a systemd unit suffix so `media.service` and `media` compare equal. */
export function baseServiceName(name: string): string {
  return name.trim().replace(/\.(service|scope|socket|timer)$/, '');
}

/**
 * Bare lower-cased host for a `verifiedDomains` entry. The twin records
 * these from the live proxy route table, which stores some as a plain host
 * (`media.dopp.cloud`) and some as a full URL (`https://media.dopp.cloud/`).
 */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/**
 * Lookup tables resolving a check's own identifiers back to the service
 * that owns them. Built from the in-memory digital twin (no agent round
 * trip), so it is cheap enough to rebuild per `/api/health/checks` GET.
 */
export interface ServiceAttributionIndex {
  /** verified proxy domain → owning service base name. */
  domains: Map<string, string>;
  /** published host port → owning service base name. */
  hostPorts: Map<number, string>;
  /** container name → owning service base name (`media-jellyfin` → `media`). */
  containers: Map<string, string>;
  /** every known service base name, for `post_deploy_failed`-style item ids. */
  services: Set<string>;
}

export const emptyAttributionIndex = (): ServiceAttributionIndex => ({
  domains: new Map(),
  hostPorts: new Map(),
  containers: new Map(),
  services: new Set(),
});

/** First writer wins — a service-level fact outranks a container-level one. */
function claim<K>(map: Map<K, string>, key: K | undefined, service: string): void {
  if (key === undefined || key === null || key === '') return;
  if (!map.has(key)) map.set(key, service);
}

/** Services contribute their own `verifiedDomains` + published host ports. */
function indexServices(index: ServiceAttributionIndex, nodeName: string): void {
  for (const svc of getServices(nodeName)) {
    const base = baseServiceName(svc.name ?? '');
    if (!base) continue;
    index.services.add(base);
    for (const d of svc.verifiedDomains ?? []) claim(index.domains, normalizeDomain(d), base);
    for (const p of svc.ports ?? []) claim(index.hostPorts, p.hostPort, base);
  }
}

/**
 * Containers contribute the `<service>-<app>` name mapping (podman stamps
 * `PODMAN_SYSTEMD_UNIT` on every stack container; the pod name is the
 * fallback) and — for multi-container stacks where the twin's reverse proxy
 * lookup matched the *container's* published port rather than the unit's —
 * that container's domains/ports fold onto its owning service too.
 */
function indexContainers(index: ServiceAttributionIndex, nodeName: string): void {
  for (const c of getContainers(nodeName)) {
    const unit = c.labels?.['PODMAN_SYSTEMD_UNIT'];
    const owner = baseServiceName(unit || c.podName || '');
    if (!owner) continue;
    for (const name of c.names ?? []) claim(index.containers, name.toLowerCase(), owner);
    // A container is only a domain/port source for a service we actually know.
    if (!index.services.has(owner)) continue;
    for (const d of c.verifiedDomains ?? []) claim(index.domains, normalizeDomain(d), owner);
    for (const p of c.ports ?? []) claim(index.hostPorts, p.hostPort, owner);
  }
}

/** Build the attribution index for one node from the in-memory digital twin. */
export function buildServiceAttributionIndex(nodeName = 'Local'): ServiceAttributionIndex {
  const index = emptyAttributionIndex();
  indexServices(index, nodeName);
  indexContainers(index, nodeName);
  return index;
}

/**
 * Owning service for a `domain`-type check: the domain itself first (the
 * twin's reverse proxy lookup), then the route's upstream port (which the
 * check already carries in `domainConfig.upstreamPort` so it can tell a
 * real backend from NPM's default page). Null when nothing on the box
 * claims the domain — an orphan route genuinely IS a box-level finding, so
 * it stays in the box-wide section rather than vanishing.
 */
export function resolveDomainCheckService(
  target: string | undefined,
  upstreamPort: number | undefined,
  index: ServiceAttributionIndex,
): string | null {
  const domain = normalizeDomain(target ?? '');
  if (domain) {
    const byDomain = index.domains.get(domain);
    if (byDomain) return byDomain;
  }
  if (typeof upstreamPort === 'number') {
    const byPort = index.hostPorts.get(upstreamPort);
    if (byPort) return byPort;
  }
  return null;
}

/**
 * How a diagnose probe's `items[].id` names its subject. Only probes whose
 * items are genuinely per-service appear here; anything absent stays
 * box-wide, which is the honest answer for a node-level probe (TLS, DNS,
 * storage, the engine itself).
 */
const PROBE_ITEM_SUBJECT: Record<string, 'container' | 'unit' | 'service'> = {
  // `podman ps` names → `media-jellyfin`
  crash_loop: 'container',
  // `systemctl --failed` names → `media.service`
  failed_units: 'unit',
  // the service whose post-deploy seed exited non-zero → `media`
  post_deploy_failed: 'service',
};

/** Owning service for one diagnose item id, given how that probe names items. */
export function resolveProbeItemService(
  itemId: string | undefined,
  subject: 'container' | 'unit' | 'service',
  index: ServiceAttributionIndex,
): string | null {
  const id = (itemId ?? '').trim();
  if (!id) return null;
  if (subject === 'container') {
    const direct = index.containers.get(id.toLowerCase());
    if (direct) return direct;
    // Fall back to the `<service>-<app>` naming convention for a container
    // the twin hasn't inventoried yet (fresh install, mid-sync).
    const prefix = id.toLowerCase().split('-')[0];
    return index.services.has(prefix) ? prefix : null;
  }
  const base = baseServiceName(id).toLowerCase();
  return index.services.has(base) ? base : null;
}

/**
 * Owning service for a whole diagnose probe row — the row is a single
 * check, so it may only be attributed when *every* item resolves to the
 * *same* service. A probe with no items is a node-level statement ("all
 * containers stable"), and a probe spanning two stacks is genuinely
 * box-wide; both return null and keep their box-wide home.
 */
export function resolveDiagnoseProbeService(
  probeId: string,
  items: { id?: string }[] | undefined,
  index: ServiceAttributionIndex,
): string | null {
  const subject = PROBE_ITEM_SUBJECT[probeId];
  if (!subject) return null;
  if (!items || items.length === 0) return null;
  let owner: string | null = null;
  for (const item of items) {
    const resolved = resolveProbeItemService(item?.id, subject, index);
    if (!resolved) return null;
    if (owner === null) owner = resolved;
    else if (owner !== resolved) return null;
  }
  return owner;
}
