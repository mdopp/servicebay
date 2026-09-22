/**
 * What is listening on this box, and what is free (#3028).
 *
 * A session inside a pod is **structurally blind** to the box's port map: it
 * sits in its own network namespace, so `ss -ltn` shows it nothing while the
 * box has fifty-odd ports taken. It cannot answer "is 3000 free?" — it can only
 * guess, and two guesses in two days cost real outages:
 *
 *   - 2026-09-21, `hostPort: 8080` collided, and the message said "change the
 *     host port and retry". The session rewrote the OTHER service's definition
 *     to free the port and sent it into a crash loop.
 *   - 2026-09-22, `hostPort: 3000` — held by ServiceBay's own backend, and by
 *     adguard. Nothing the session could have read would have told it.
 *
 * That second one is why `services --json` is not the answer: the ports that
 * matter are not only ServiceBay's. sshd, Samba, llama, adguard and the control
 * plane itself are all invisible to a service listing, and all of them will
 * refuse a bind just as hard.
 *
 * So this reads the box's own listener table and says who holds what — service
 * or not — and which ports are free. It is `read`-tier and answers a question
 * asked BEFORE acting, rather than an error message read afterwards.
 *
 * ## What it deliberately does not do
 *
 * Resolve a port automatically at deploy time. A port is part of a service's
 * identity: the proxy route, the firewall rule, the healthcheck annotation and
 * the operator's bookmark all name it. Quietly moving 3000 to 8090 leaves a
 * definition that lies — the same class as `ownershipSet: true` — makes a
 * redeploy non-deterministic, and breaks the annotation that still points at
 * the old one. Refuse what cannot work, say what would, and let a human choose
 * (#3020's rule, applied here).
 */

interface PortUse {
  port: number;
  protocol: 'tcp' | 'udp';
  /** The service, the process, or `unknown` when the box will not say. */
  owner: string;
  /**
   * `service` — an installed ServiceBay service declares it;
   * `control-plane` — ServiceBay itself (the case that bit on 2026-09-22);
   * `other` — something on the host that is no ServiceBay service at all, and
   * exactly what a service listing cannot show you.
   */
  kind: 'service' | 'control-plane' | 'other';
  /** The address it is bound to, so `127.0.0.1` can be told from `0.0.0.0`. */
  address: string;
}

export interface PortReport {
  node: string;
  ports: PortUse[];
  /** A few ports nothing holds, as a starting point — never an assignment. */
  free: number[];
  summary: string;
}

/** Ports the control plane itself owns. Named, because a service listing will
 *  never show them and a session that picks one gets a bind failure it cannot
 *  explain. */
const CONTROL_PLANE_PORTS = new Map<number, string>([
  [3000, 'servicebay (the control plane UI/backend)'],
  [5888, 'servicebay (the API and MCP endpoint)'],
]);

/**
 * One `ss -tulpnH` row → a listening port, or null for a line we cannot read.
 *
 * Format: `Netid State Recv-Q Send-Q Local:Port Peer:Port [users:(("name",pid=…))]`
 * Exported because the parsing, not the command, is where this goes wrong: an
 * IPv6 address carries colons of its own, and splitting on the first one turns
 * `[::]:8080` into nonsense.
 */
export function parseSsLine(line: string): { port: number; protocol: 'tcp' | 'udp'; address: string; process?: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const netid = parts[0];
  const protocol = netid.startsWith('udp') ? 'udp' : netid.startsWith('tcp') ? 'tcp' : null;
  if (!protocol) return null;

  const local = parts[4];
  // Split on the LAST colon: `0.0.0.0:8080`, `[::]:8080`, `[::1]:5888`,
  // `*:53` all end in `:port`, and an IPv6 address is full of colons.
  const cut = local.lastIndexOf(':');
  if (cut < 0) return null;
  const port = Number(local.slice(cut + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const address = local.slice(0, cut).replace(/^\[|\]$/g, '') || '*';

  const users = parts.slice(6).join(' ');
  const name = /users:\(\("([^"]+)"/.exec(users)?.[1];
  return { port, protocol, address, ...(name ? { process: name } : {}) };
}

export interface ServicePorts {
  name: string;
  ports?: { host?: string | number | null }[];
}

/**
 * Merge the box's listener table with the service list into one answer.
 *
 * A port is reported once per protocol, and a service name wins over a process
 * name: `8096 media` is more useful than `8096 conmon`.
 */
/** host port → the service that declares it. */
function declaredServicePorts(services: ServicePorts[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const s of services) {
    for (const p of s.ports ?? []) {
      const host = Number(p?.host);
      if (Number.isInteger(host) && host > 0) out.set(host, s.name);
    }
  }
  return out;
}

/** Who holds this port, and in which of the three senses. A service name wins
 *  over a process name: `8096 media` is more useful than `8096 conmon`. */
function ownerOf(port: number, byService: Map<number, string>, process?: string): Pick<PortUse, 'owner' | 'kind'> {
  const service = byService.get(port);
  if (service) return { owner: service, kind: 'service' };
  const control = CONTROL_PLANE_PORTS.get(port);
  if (control) return { owner: control, kind: 'control-plane' };
  return { owner: process ?? 'unknown', kind: 'other' };
}

export function buildPortReport(
  node: string,
  /**
   * The box's listener table, or **null when it could not be read**.
   *
   * The distinction is the whole safety of this report. The declared service
   * ports alone are not a port map: they miss sshd, adguard and the control
   * plane — precisely the three that caused the outages. Returning them under a
   * failed read would hand back a plausible-looking answer that is missing the
   * ports that actually bite.
   */
  listening: { port: number; protocol: 'tcp' | 'udp'; address: string; process?: string }[] | null,
  services: ServicePorts[],
  freeCount = 3,
): PortReport {
  if (listening === null) {
    return {
      node,
      ports: [],
      free: [],
      summary: 'Could not read the box\'s listener table, so this says nothing about what is free. '
        + 'Do not read an empty list as "everything is available" — the ports that matter here '
        + '(sshd, adguard, ServiceBay itself) are not in any service listing.',
    };
  }
  const byService = declaredServicePorts(services);
  const seen = new Map<string, PortUse>();
  for (const l of listening) {
    const key = `${l.protocol}:${l.port}`;
    if (seen.has(key)) continue;
    seen.set(key, { port: l.port, protocol: l.protocol, address: l.address, ...ownerOf(l.port, byService, l.process) });
  }

  // A declared service port that nothing is listening on is still TAKEN: the
  // service owns it whether or not it is running (#2994), and a caller that
  // picks it gets a collision refusal, not a free port.
  for (const [port, name] of byService) {
    const key = `tcp:${port}`;
    if (!seen.has(key)) {
      seen.set(key, { port, protocol: 'tcp', address: '(declared, not listening)', owner: name, kind: 'service' });
    }
  }

  const ports = [...seen.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  const taken = new Set(ports.map(p => p.port));
  const free: number[] = [];
  // Above the privileged range and clear of the crowded 8080/8000 neighbourhood
  // so a suggestion is unlikely to collide with the next template either.
  for (let p = 8090; p <= 8199 && free.length < freeCount; p++) {
    if (!taken.has(p)) free.push(p);
  }

  return {
    node,
    ports,
    free,
    summary: ports.length === 0
      ? `Nothing is listening on ${node} and no service declares a port. That is unusual — treat it as a reading you should confirm before you rely on it.`
      : `${ports.length} port(s) in use on ${node}, ${ports.filter(p => p.kind !== 'service').length} of them held by something that is NOT a ServiceBay service `
        + `— those are the ones a service listing cannot show you. Free to start from: ${free.join(', ') || '(none found in 8090-8199)'}.`,
  };
}

/** Free ports for a collision message, given what is taken. */
export function suggestFreePorts(taken: Iterable<number>, count = 3): number[] {
  const used = new Set(taken);
  const out: number[] = [];
  for (let p = 8090; p <= 8199 && out.length < count; p++) {
    if (!used.has(p)) out.push(p);
  }
  return out;
}
