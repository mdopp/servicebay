/**
 * `dangling_proxy` — what KIND of dangling a route actually is (#2611).
 *
 * "The forward target isn't served" collapsed three different situations
 * into one finding with one offered fix, "Delete route":
 *
 *   1. the service that owned the domain is gone       → delete is right
 *   2. the service is still there but publishes nothing → delete is wrong
 *   3. the service is running and publishes a DIFFERENT
 *      port than the route forwards to                  → delete is wrong
 *
 * (3) is what a redeploy produces when the published host port moves:
 * `daggerheart-chronik` republished on 8701 while
 * `daggerheart.dopp.cloud` stayed on 8700. Clicking "Delete route" there
 * does not fix anything — it gives up the subdomain and its certificate
 * binding to correct a wrong number. The fix is to move the route.
 *
 * Same shape #2594 fixed for certificates: one probe, two causes, an
 * offered action that makes the worse one worse. This module is the pure
 * half — no I/O — so both the probe (twin data, hourly) and the action
 * handler (re-derived at click time) classify by the same rule.
 *
 * The ownership link is `config.reverseProxy.hosts[]`: it records which
 * service a domain was created for. The port to move TO is never read
 * from that record — the recorded `forwardPort` is exactly the value
 * that went stale. It comes from what the service publishes right now.
 */

import type { ProbeItem } from '../actions';

/** One `config.reverseProxy.hosts[]` entry, reduced to the ownership link. */
export interface RouteOwner {
  domain: string;
  service: string;
}

/** A published port of a service, as the digital twin records it. */
export interface PublishedPort {
  hostPort?: number;
  containerPort?: number;
  protocol?: string;
  /** Bind address on the host — `127.0.0.1` for loopback-only publishes. */
  hostIp?: string;
}

/** A service as far as this classification cares. */
export interface RouteTargetService {
  name: string;
  ports?: PublishedPort[];
}

/** The NPM proxy host under test. */
export interface DanglingRoute {
  /** Primary `server_name`. Absent for an unnamed nginx server block. */
  domain?: string;
  targetHost?: string;
  targetPort: number;
}

/**
 * What is actually wrong with this route.
 *
 * `port-moved` is the only verdict that carries a repoint target, and it
 * is only ever reached when exactly one published port is a defensible
 * answer. When several are, the verdict is `port-ambiguous` and NO fix is
 * offered: sending a domain to a guessed port is its own outage, and
 * "delete" is still the wrong answer because the service is alive.
 */
export type DanglingRouteVerdict =
  | { kind: 'port-moved'; service: string; to: number; forwardHost?: string }
  | { kind: 'port-ambiguous'; service: string; candidates: number[] }
  | { kind: 'service-silent'; service: string }
  | { kind: 'target-gone'; service?: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
/** A wildcard bind serves every address, so it says nothing about where
 *  the proxy should forward — the route's current host stays correct. */
const WILDCARD_BIND = new Set(['', '0.0.0.0', '::', '*']);

/**
 * Forward host a repoint should use, or `undefined` to keep whatever the
 * route already forwards to. Mirrors the convention `buildProxyHosts`
 * applies at install time (`loopbackOnly` → `127.0.0.1`, because NPM runs
 * with `hostNetwork: true` and shares the host's loopback).
 */
export function forwardHostForPort(hostIp?: string): string | undefined {
  const ip = (hostIp ?? '').trim();
  if (WILDCARD_BIND.has(ip)) return undefined;
  if (LOOPBACK.has(ip)) return '127.0.0.1';
  return ip;
}

/** TCP publishes only — a UDP mapping cannot serve an HTTP route. */
function servableTcpPorts(service: RouteTargetService): PublishedPort[] {
  return (service.ports ?? []).filter(p => {
    const proto = (p.protocol ?? 'tcp').toLowerCase();
    return proto === 'tcp' && typeof p.hostPort === 'number' && Number.isFinite(p.hostPort) && p.hostPort > 0;
  });
}

/**
 * Classify one route whose forward target is not served by anything on
 * the node.
 *
 * Caller contract: only pass routes already found dangling. A route that
 * reaches a published port is not this module's business.
 */
export function classifyDanglingRoute(
  route: DanglingRoute,
  owners: RouteOwner[],
  services: RouteTargetService[],
): DanglingRouteVerdict {
  const domain = route.domain?.toLowerCase();
  const service = domain
    ? owners.find(o => o.domain.toLowerCase() === domain)?.service
    : undefined;
  // No recorded owner: nothing links this NPM host to a service, so
  // "the service moved" cannot be established. Unchanged from before.
  if (!service) return { kind: 'target-gone' };

  const target = services.find(s => s.name === service);
  if (!target) return { kind: 'target-gone', service };

  const published = servableTcpPorts(target).filter(p => p.hostPort !== route.targetPort);
  if (published.length === 0) {
    // The service exists but publishes nothing we could forward to —
    // either it is stopped or its ports were withdrawn entirely.
    return { kind: 'service-silent', service };
  }

  const chosen = pickRepointTarget(published, route.targetPort);
  if (!chosen) {
    const candidates = [...new Set(published.map(p => p.hostPort as number))].sort((a, b) => a - b);
    return { kind: 'port-ambiguous', service, candidates };
  }
  return {
    kind: 'port-moved',
    service,
    to: chosen.hostPort as number,
    forwardHost: forwardHostForPort(chosen.hostIp),
  };
}

/**
 * The one published port a repoint may target, or `null` when the answer
 * isn't singular.
 *
 * Two ways to be singular, in order:
 *   1. the service still exposes the SAME container port, only the host
 *      mapping moved (the classic auto-bumped-on-conflict republish);
 *   2. the service publishes exactly one port at all.
 *
 * Anything else is a guess, and a guess here silently points a live
 * domain at the wrong process.
 */
function pickRepointTarget(published: PublishedPort[], oldPort: number): PublishedPort | null {
  const sameContainerPort = published.filter(p => p.containerPort === oldPort);
  if (sameContainerPort.length === 1) return sameContainerPort[0];
  const distinctHostPorts = new Set(published.map(p => p.hostPort));
  if (distinctHostPorts.size === 1) return published[0];
  return null;
}

/** Human-readable second line for a route row, verdict-specific. */
export function describeRouteVerdict(route: DanglingRoute, verdict: DanglingRouteVerdict): string {
  const target = `→ ${route.targetHost ?? '?'}:${route.targetPort}`;
  switch (verdict.kind) {
    case 'port-moved':
      return `${target} — ${verdict.service} is running and publishes ${verdict.to}, not ${route.targetPort}. The route stayed on the old port.`;
    case 'port-ambiguous':
      return `${target} — ${verdict.service} is running but publishes ${verdict.candidates.join(', ')}; none of them is ${route.targetPort}, and no single one is the obvious replacement.`;
    case 'service-silent':
      return `${target} — ${verdict.service} still exists but publishes no port right now, so nothing can answer here.`;
    case 'target-gone':
      return verdict.service
        ? `${target} — no service called ${verdict.service} on this node any more.`
        : `${target} — nothing on this node publishes ${route.targetPort}, and no recorded route claims this domain.`;
  }
}

/** Which fix, if any, this verdict earns. */
export function actionIdsForVerdict(verdict: DanglingRouteVerdict): string[] {
  switch (verdict.kind) {
    case 'port-moved':
      return ['repoint_route'];
    // The service is alive: deleting its route is the fix that makes the
    // state worse, so it is deliberately not offered. `port-ambiguous`
    // gets nothing at all — the row says which ports exist and the
    // operator picks on the service page.
    case 'port-ambiguous':
      return [];
    case 'service-silent':
    case 'target-gone':
      return ['delete_route'];
  }
}

/** Build the `items[]` row for one classified route. */
export function buildRouteItem(route: DanglingRoute, verdict: DanglingRouteVerdict): ProbeItem {
  return {
    id: route.domain ?? `unnamed-${route.targetHost ?? 'unknown'}-${route.targetPort}`,
    label: route.domain ?? '(unnamed)',
    detail: describeRouteVerdict(route, verdict),
    status: 'warn',
    // An unnamed server block has no id to dispatch against, so it stays
    // a read-only row whatever the verdict.
    actionIds: route.domain ? actionIdsForVerdict(verdict) : [],
  };
}

/** Counts behind the probe's one-line detail. */
export interface RouteStateTally {
  /** Every proxy route the twin knows about — the denominator. */
  total: number;
  moved: number;
  ambiguous: number;
  silent: number;
  gone: number;
  /** Recorded routes NPM never created (the `proxy_route_missing` half). */
  missing: number;
}

export function tallyRouteStates(
  total: number,
  verdicts: DanglingRouteVerdict[],
  missing: number,
): RouteStateTally {
  const count = (kind: DanglingRouteVerdict['kind']) => verdicts.filter(v => v.kind === kind).length;
  return {
    total,
    moved: count('port-moved'),
    ambiguous: count('port-ambiguous'),
    silent: count('service-silent'),
    gone: count('target-gone'),
    missing,
  };
}

/**
 * The probe's `detail` line. Always leads with the denominator — how many
 * routes were examined — so "1 broken" can never be read as "everything
 * is broken", and a run that examined nothing cannot read as a clean run.
 */
export function formatRouteStateDetail(tally: RouteStateTally): string {
  const parts: string[] = [];
  const wrong = tally.moved + tally.ambiguous;
  if (wrong > 0) {
    parts.push(`${wrong} of ${tally.total} point at a port their service no longer publishes`);
  }
  if (tally.silent > 0) {
    parts.push(`${tally.silent} of ${tally.total} point at a service that publishes nothing right now`);
  }
  if (tally.gone > 0) {
    parts.push(`${tally.gone} of ${tally.total} point at a service that is gone`);
  }
  if (tally.missing > 0) {
    parts.push(`${tally.missing} recorded route${tally.missing === 1 ? '' : 's'} never got created in NPM`);
  }
  if (parts.length === 0) {
    return `${tally.total} proxy route${tally.total === 1 ? '' : 's'}, all reaching a port their service publishes.`;
  }
  return `${tally.total} proxy route${tally.total === 1 ? '' : 's'}: ${parts.join(' · ')}.`;
}

/** The probe's `hint` — only names fixes for states actually present. */
export function formatRouteStateHint(tally: RouteStateTally): string | undefined {
  const lines: string[] = [];
  if (tally.moved > 0) {
    lines.push('"Repoint route" moves the route to the port the service publishes now — the subdomain and its certificate stay as they are. Deleting such a route would give up a working domain to fix a wrong number.');
  }
  if (tally.ambiguous > 0) {
    lines.push('Rows with no button: the service is running but publishes several ports, so there is no safe automatic choice — set the right one on the service page.');
  }
  if (tally.silent > 0 || tally.gone > 0) {
    lines.push('"Delete route" removes an NPM host whose service is gone or silent — permanent, and the domain has to be re-created afterwards.');
  }
  if (tally.missing > 0) {
    lines.push('"Retry create" pushes a missing route back into NPM (most often a wrong-creds failure — see npm_data_stale).');
  }
  return lines.length > 0 ? lines.join(' ') : undefined;
}
