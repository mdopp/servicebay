/**
 * `dangling_proxy` — what KIND of dangling a route actually is (#2611).
 *
 * #2860 added a fourth: the forward `host:port` has no LISTENER at all,
 * even though a service entry of that name still exists on the node. A
 * removed service that leaves a `.container` quadlet behind keeps its
 * declared PublishPort in the twin, so the twin-only check rated
 * `ollama.dopp.cloud` → `127.0.0.1:11434` healthy with ollama long gone.
 * That verdict is `no-listener`, and it is kept separate from
 * `target-gone` on purpose: the row has to say WHICH check failed —
 * "no listener on 127.0.0.1:11434" is a different repair from "no
 * service named ollama".
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
 * #3049 added a fifth, and it is the inverse mistake: the port is RIGHT
 * and the ADDRESS moved. AdGuard's quadlet publishes 8083, so the twin
 * records it on the LAN IP, but AdGuard's own config binds the web UI to
 * `127.0.0.1:8083`. `dns.dopp.cloud` forwarded to the LAN address, which
 * refuses — and because AdGuard also publishes 53, the port-only logic
 * concluded "publishes 53, not 8083" and offered to move the admin UI
 * onto the DNS port. That verdict is `bind-moved`: same port, new host.
 * It is checked before any port move, because keeping the port is the
 * narrower repair, and it requires the service's own record to claim the
 * port so an unrelated process holding it elsewhere cannot capture the
 * route. Note the twin's `hostIp` is useless here — it is what the
 * quadlet asked for, not what the app bound — so the addresses come from
 * the `ss -ltn` snapshot.
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
  /**
   * Does anything actually have `targetHost:targetPort` open right now
   * (#2860)? From the run's single `ss -ltn` snapshot — see
   * `lib/diagnose/listenSnapshot.ts`. `undefined` means the snapshot
   * could not answer, and is never read as "closed".
   */
  listening?: boolean;
  /**
   * Every bind address the snapshot saw for `targetPort`, whether or not
   * `targetHost` can reach them (#3049). This is what separates "the port
   * moved" from "the port is fine, the bind address moved": when
   * `listening` is false but this is non-empty, something IS serving the
   * port, just not where the route looks for it.
   *
   * Comes from the snapshot, never from the twin — a host-network
   * container's declared `hostIp` is what the quadlet asked for, not what
   * the app inside chose to bind, and on the box those disagree.
   */
  observedBinds?: string[];
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
  | { kind: 'bind-moved'; service: string; port: number; forwardHost: string }
  | { kind: 'port-ambiguous'; service: string; candidates: number[] }
  | { kind: 'service-silent'; service: string }
  | { kind: 'no-listener'; service?: string }
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

/** Loopback in every spelling, including the whole `127.0.0.0/8` block. */
function isLoopbackAddr(addr: string): boolean {
  return LOOPBACK.has(addr) || addr.startsWith('127.');
}

/**
 * #3049 — the forward host a repoint should use when the route's PORT is
 * open but not on the address the route forwards to, or `undefined` when
 * the observed binds give no single defensible answer.
 *
 * Loopback wins outright: NPM runs with `hostNetwork: true` and shares the
 * host's loopback, so a service that moved its bind to `127.0.0.1` is
 * reachable there and nowhere else. Otherwise exactly one other address
 * has to be on offer — several is a guess, and a guess sends a live domain
 * at the wrong interface.
 */
export function forwardHostForObservedBinds(
  observedBinds: string[] | undefined,
  currentHost?: string,
): string | undefined {
  const addrs = (observedBinds ?? [])
    .map(b => b.trim())
    .filter(b => !WILDCARD_BIND.has(b));
  const current = (currentHost ?? '').trim();
  // A bind the route already points at is not a move.
  const candidates = [...new Set(addrs.filter(a => a !== current))];
  if (candidates.length === 0) return undefined;
  if (candidates.some(isLoopbackAddr)) return '127.0.0.1';
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Is this route dangling at all (#3049)? The gate in front of every
 * verdict below, kept here so the precedence is one testable rule rather
 * than a condition buried in the diagnose run.
 *
 * Evidence order matters. A live listener on the forward port is direct
 * proof the route reaches something, and it outranks `portIsKnown` — the
 * twin's "some managed service declares this port", which is blind to
 * host processes. `llama.dopp.cloud` → 11435 is served by a host-side
 * model router, so it was permanently reported as drifted with an offered
 * repoint onto llama.cpp's 11434 that would have bypassed the router.
 *
 * `listening === undefined` means the snapshot could not be read; only
 * then does the twin get a vote, because guessing "closed" from a failed
 * `ss` would offer to delete healthy routes (#2860).
 */
export function isRouteDangling(listening: boolean | undefined, portIsKnown: boolean): boolean {
  if (listening === true) return false;
  if (listening === false) return true;
  return !portIsKnown;
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
  const verdict = classifyFromServices(route, owners, services);
  // #3049 — before anything else: the owning service declares THIS port
  // and the port is genuinely open, just not on the address the route
  // forwards to. Then the port was never the problem and moving it is the
  // wrong repair.
  //
  // This is `dns.dopp.cloud` on the box: AdGuard's quadlet publishes 8083
  // so the twin records `hostIp: 192.168.178.100`, but AdGuard's own
  // config binds its web UI to `127.0.0.1:8083`. The route forwarded to
  // the LAN address, which refuses — and because AdGuard also publishes
  // 53, `classifyFromServices` concluded "publishes 53, not 8083" and
  // offered to repoint the admin UI onto the DNS port. Nobody noticed the
  // route was broken at all, because Authelia bounces you to the login
  // page before the upstream is ever reached.
  //
  // Checked first, and deliberately narrow: it requires the service's own
  // record to claim this exact port, so an unrelated process that happens
  // to hold the port on another address can never capture the route.
  const owner = serviceForVerdict(verdict);
  if (route.listening === false && owner && declaresPort(services, owner, route.targetPort)) {
    const forwardHost = forwardHostForObservedBinds(route.observedBinds, route.targetHost);
    if (forwardHost) {
      return { kind: 'bind-moved', service: owner, port: route.targetPort, forwardHost };
    }
  }
  // #2860 — the entry claims to publish this very port and nothing is
  // listening on it: the service record is stale, not merely stopped.
  // Deliberately narrow. `target-gone` keeps its own reason ("no service
  // named X" is sharper, and it is what the operator acts on); a live
  // service on another port stays a repoint; and a service that
  // publishes NO port is #2611's `service-silent` — stopped, not
  // orphaned, and deleting its domain is still the wrong fix.
  if (route.listening === false && verdict.kind === 'service-silent' && declaresPort(services, verdict.service, route.targetPort)) {
    return { kind: 'no-listener', service: verdict.service };
  }
  return verdict;
}

/** The owning service a verdict names, if it names one. */
function serviceForVerdict(verdict: DanglingRouteVerdict): string | undefined {
  return verdict.service;
}

/** Does this service's record claim to publish `port` over TCP? */
function declaresPort(services: RouteTargetService[], name: string, port: number): boolean {
  const target = services.find(s => s.name === name);
  return !!target && servableTcpPorts(target).some(p => p.hostPort === port);
}

/** The twin-only half of the classification: what the recorded owner and
 *  its published ports say about this route. */
function classifyFromServices(
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
    case 'bind-moved':
      return `${target} — port ${verdict.port} is right, the address is not: ${verdict.service} publishes ${verdict.port} but binds it on ${(route.observedBinds ?? []).join(', ') || verdict.forwardHost}, so ${route.targetHost ?? '?'} refuses the connection. The route needs ${verdict.forwardHost}:${verdict.port}.`;
    case 'port-ambiguous':
      return `${target} — ${verdict.service} is running but publishes ${verdict.candidates.join(', ')}; none of them is ${route.targetPort}, and no single one is the obvious replacement.`;
    case 'service-silent':
      return `${target} — ${verdict.service} still exists but publishes no port right now, so nothing can answer here.`;
    case 'no-listener':
      return verdict.service
        ? `${target} — no listener on ${route.targetHost ?? '?'}:${route.targetPort}. A service entry called ${verdict.service} is still on the node, but nothing has the port open.`
        : `${target} — no listener on ${route.targetHost ?? '?'}:${route.targetPort}. Nothing has the port open.`;
    case 'target-gone':
      return verdict.service
        ? `${target} — no service called ${verdict.service} on this node any more.`
        : `${target} — nothing on this node publishes ${route.targetPort}, and no recorded route claims this domain.`;
  }
}

/** Which fix, if any, this verdict earns. */
export function actionIdsForVerdict(verdict: DanglingRouteVerdict): string[] {
  switch (verdict.kind) {
    // Both move kinds earn the same button: one narrow NPM PUT that
    // patches forward_host as well as forward_port, which is exactly
    // what a bind move needs and what a port move already used.
    case 'port-moved':
    case 'bind-moved':
      return ['repoint_route'];
    // The service is alive: deleting its route is the fix that makes the
    // state worse, so it is deliberately not offered. `port-ambiguous`
    // gets nothing at all — the row says which ports exist and the
    // operator picks on the service page.
    case 'port-ambiguous':
      return [];
    case 'service-silent':
    case 'no-listener':
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
  /** Right port, wrong address (#3049). */
  bindMoved: number;
  ambiguous: number;
  silent: number;
  /** Forward port open by nobody, service entry notwithstanding (#2860). */
  noListener: number;
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
    bindMoved: count('bind-moved'),
    ambiguous: count('port-ambiguous'),
    silent: count('service-silent'),
    noListener: count('no-listener'),
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
  if (tally.bindMoved > 0) {
    parts.push(`${tally.bindMoved} of ${tally.total} use the right port on an address their service does not bind`);
  }
  if (tally.silent > 0) {
    parts.push(`${tally.silent} of ${tally.total} point at a service that publishes nothing right now`);
  }
  if (tally.noListener > 0) {
    parts.push(`${tally.noListener} of ${tally.total} forward to a port nothing is listening on`);
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
  if (tally.bindMoved > 0) {
    lines.push('Rows reading "the address is not": the service publishes the port the route uses but binds it to a different address (typically 127.0.0.1 instead of the LAN IP), so the forward is refused. "Repoint route" moves the forward HOST and leaves the port alone.');
  }
  if (tally.ambiguous > 0) {
    lines.push('Rows with no button: the service is running but publishes several ports, so there is no safe automatic choice — set the right one on the service page.');
  }
  if (tally.noListener > 0) {
    lines.push('Rows reading "no listener": the port the route forwards to is closed, even though a service entry of that name is still on disk — usually a removed service whose quadlet file survived. Check the service before deleting the domain.');
  }
  if (tally.silent > 0 || tally.gone > 0 || tally.noListener > 0) {
    lines.push('"Delete route" removes an NPM host whose service is gone or silent — permanent, and the domain has to be re-created afterwards.');
  }
  if (tally.missing > 0) {
    lines.push('"Retry create" pushes a missing route back into NPM (most often a wrong-creds failure — see npm_data_stale).');
  }
  return lines.length > 0 ? lines.join(' ') : undefined;
}
