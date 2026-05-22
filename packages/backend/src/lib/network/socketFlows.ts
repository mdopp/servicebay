/**
 * Service↔service socket-flow discovery (#505 / PR-1).
 *
 * The network map should show what is *actually* talking to what.
 * `getNodeGraph` already renders gateway / proxy structure; this module
 * adds the observed service↔service edges.
 *
 * Approach — `ss`, not `conntrack`. Every ServiceBay template runs
 * `hostNetwork: true`, so all service↔service traffic is host-local with
 * ephemeral source ports: `conntrack -L` gives the 4-tuple but cannot
 * attribute the *source* service. `ss -Htnp` names the owning PID on the
 * local end of every TCP socket, and a single host-side call sees every
 * container's sockets while they share the host netns:
 *   - LISTEN rows  → which port a service listens on (PID → container).
 *   - ESTAB rows   → who connected to whom (PID → source container,
 *                    peer port → destination service).
 *
 * Collection is isolated behind `collectHostSockets()` so that once the
 * hostNetwork hardening (#817) moves apps into their own netns, a
 * per-pod `ss` scan can be added as a second source without touching
 * the flow store or the edge synthesis.
 */
import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import type { ResolvedFlow } from './flowsStore';

/** One TCP socket as `ss -Htnp` reports it on the host. */
export interface RawSocketRow {
  state: string; // ESTAB | LISTEN | …
  localAddr: string;
  localPort: number;
  peerAddr: string;
  peerPort: number;
  /** PIDs owning the local socket (`users:(("p",pid=N,fd=M),…)`). */
  pids: number[];
}

export interface HostSockets {
  established: RawSocketRow[];
  listening: RawSocketRow[];
  /** PID → 64-hex podman container id, from `/proc/<pid>/cgroup`. */
  pidToContainer: Map<number, string>;
}

/** Split a `ss -n` address token into host + port. Handles bracketed
 *  IPv6 (`[::1]:9091`), v4-mapped (`::ffff:1.2.3.4:80`), wildcard
 *  (`*:80`) and plain v4. */
export function splitAddrPort(token: string): { addr: string; port: number } | null {
  let addr: string;
  let portStr: string;
  if (token.startsWith('[')) {
    const close = token.indexOf(']');
    if (close < 0) return null;
    addr = token.slice(1, close);
    portStr = token.slice(close + 2); // skip ']:'
  } else {
    const lastColon = token.lastIndexOf(':');
    if (lastColon < 0) return null;
    addr = token.slice(0, lastColon);
    portStr = token.slice(lastColon + 1);
  }
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { addr, port };
}

/**
 * Parse `ss -Htnp` output (every TCP socket, no header). Each line:
 *   `<State> <Recv-Q> <Send-Q> <Local> <Peer> users:(("name",pid=N,…))`
 * Lines without a parseable local/peer pair are skipped. Exported pure
 * for unit testing — the column heuristics are worth pinning.
 */
export function parseSsRows(raw: string): RawSocketRow[] {
  const rows: RawSocketRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const local = splitAddrPort(parts[3]);
    if (!local) continue;
    // Peer is `*:*` on LISTEN rows — unparseable, and that's fine: only
    // ESTAB rows need a real peer. Keep the row either way.
    const peer = splitAddrPort(parts[4]);
    const processCol = parts.slice(5).join(' ');
    const pids: number[] = [];
    for (const m of processCol.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(m[1], 10);
      if (Number.isFinite(pid) && !pids.includes(pid)) pids.push(pid);
    }
    rows.push({
      state: parts[0].toUpperCase(),
      localAddr: local.addr,
      localPort: local.port,
      peerAddr: peer?.addr ?? '',
      peerPort: peer?.port ?? 0,
      pids,
    });
  }
  return rows;
}

/**
 * Parse a `<pid> <cgroup-line>` dump into a PID → container-id map.
 * Podman writes each container's processes under a `libpod-<id>.scope`
 * cgroup. Lines without that segment (host / system processes) skip.
 */
export function parseCgroupMap(raw: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, sp), 10);
    if (!Number.isFinite(pid)) continue;
    const m = trimmed.slice(sp + 1).match(/libpod-([0-9a-f]{12,64})\.scope/);
    if (m) map.set(pid, m[1]);
  }
  return map;
}

/** DNS — every service does it; never interesting as a map edge (#505). */
const DROP_PORTS = new Set([53]);

/**
 * Synthesize directed service→service flows from a host-socket sample.
 * Pure — exported for unit testing.
 *
 *   1. LISTEN rows give `port → container → service` (the destination).
 *   2. ESTAB rows give `pid → container → service` (the source) and a
 *      `peerPort`; an edge is emitted only when `peerPort` is a known
 *      listening service port.
 *
 * Drops: unresolvable ends, self-edges (intra-pod / loopback to own
 * service) and DNS. The result is one entry per observed connection —
 * the store dedups + counts.
 */
export function resolveFlows(
  sockets: HostSockets,
  containerToService: Map<string, string>,
): ResolvedFlow[] {
  const serviceOfPid = (pids: number[]): string | undefined => {
    for (const pid of pids) {
      const cid = sockets.pidToContainer.get(pid);
      const svc = cid && containerToService.get(cid);
      if (svc) return svc;
    }
    return undefined;
  };

  // port → destination service, from the LISTEN rows.
  const portToService = new Map<number, string>();
  for (const row of sockets.listening) {
    if (row.state !== 'LISTEN') continue;
    const svc = serviceOfPid(row.pids);
    if (svc) portToService.set(row.localPort, svc);
  }

  const flows: ResolvedFlow[] = [];
  for (const row of sockets.established) {
    if (row.state !== 'ESTAB') continue;
    if (DROP_PORTS.has(row.peerPort)) continue;
    const dstService = portToService.get(row.peerPort);
    if (!dstService) continue; // peer port isn't a known service → skip
    const srcService = serviceOfPid(row.pids);
    if (!srcService) continue;
    if (srcService === dstService) continue; // self / intra-pod loopback
    flows.push({ srcService, dstService, dstPort: row.peerPort });
  }
  return flows;
}

/** `for` loop over `/proc/<pid>/cgroup`, emitting `<pid> <cgroup>` per
 *  line. cgroup v2 (Fedora CoreOS) writes a single line per file. */
const CGROUP_DUMP_CMD =
  'for f in /proc/[0-9]*/cgroup; do d=${f%/cgroup}; echo "${d##*/} $(cat "$f" 2>/dev/null)"; done';

/**
 * Sample the host's TCP sockets + the PID→container cgroup map. One-shot.
 * Best-effort: any agent / parse failure returns empty sets so a
 * sampling tick can never break the network map.
 */
export async function collectHostSockets(node: string): Promise<HostSockets> {
  const empty: HostSockets = { established: [], listening: [], pidToContainer: new Map() };
  try {
    const agent = await agentManager.ensureAgent(node);
    const ss = await agent.sendCommand('exec', { command: 'ss -Htnp' });
    const rows = parseSsRows(ss.stdout || '');
    if (rows.length === 0) return empty;
    const cg = await agent.sendCommand('exec', { command: CGROUP_DUMP_CMD });
    return {
      established: rows.filter(r => r.state === 'ESTAB'),
      listening: rows.filter(r => r.state === 'LISTEN'),
      pidToContainer: parseCgroupMap(cg.stdout || ''),
    };
  } catch (e) {
    logger.warn('SocketFlows', `collectHostSockets(${node}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}
