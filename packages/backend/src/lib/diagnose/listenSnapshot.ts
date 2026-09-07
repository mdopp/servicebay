/**
 * One `ss -ltn` snapshot per diagnose run (#2860).
 *
 * Two probes need to know what is actually bound on the host:
 *
 *   - `Open TCP ports` wants the set of listening ports;
 *   - `Reverse-proxy routes` wants to know whether a route's forward
 *     `host:port` has anyone behind it at all.
 *
 * The second one is why this module exists. `dangling_proxy` used to
 * decide "is this route served?" purely from the digital twin — a port
 * appearing in `twin.services[].ports` or `twin.containers[].ports` was
 * taken as proof that something answers there. A removed service that
 * leaves a `.container` quadlet behind keeps its entry (and its declared
 * PublishPort) in the twin, so the route was rated healthy while nothing
 * had the port open: `ollama.dopp.cloud` → `127.0.0.1:11434` with the
 * ollama container long gone.
 *
 * The check has to stay cheap — diagnose runs hourly and on demand, and
 * the box has ~29 routes. So it is ONE `ss -ltn` per run, parsed here,
 * and every route is answered from that in-memory snapshot; never a
 * per-route TCP connect, and never an unbounded exec.
 *
 * An unreadable snapshot is `empty` and answers `undefined` — "unknown",
 * never "closed". Guessing "closed" from a failed `ss` would delete
 * healthy routes.
 */

/**
 * The bounded snapshot command. Emits the deduplicated
 * `Local Address:Port` column of `ss -ltn` (one token per line), which
 * keeps the bind address — a route to `127.0.0.1:8096` is not served by
 * a listener bound only to a LAN address.
 */
export const LISTEN_SNAPSHOT_COMMAND =
  'ss -ltn 2>/dev/null | tail -n +2 | awk \'{print $4}\' | sort -u';

/** How long the snapshot exec may take before diagnose gives up on it. */
const LISTEN_SNAPSHOT_TIMEOUT_MS = 4000;

export interface ListenSnapshot {
  /** Every distinct listening host port, ascending. */
  ports: number[];
  /** port → the bind addresses seen for it (`0.0.0.0`, `::`, `127.0.0.1`, …). */
  binds: Map<number, string[]>;
  /** Nothing parsed — the snapshot says nothing at all, not "all closed". */
  empty: boolean;
}

/** Binds that serve every local address, so any forward host reaches them. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*', '']);

/** Split an `ss -n` address token into its address and port halves.
 *  Handles `0.0.0.0:80`, `*:22`, `[::]:8096` and `[fe80::1%eth0]:546`. */
function splitBindToken(token: string): { addr: string; port: number } | null {
  let addr: string;
  let portPart: string;
  if (token.startsWith('[')) {
    const close = token.indexOf(']');
    if (close < 0) return null;
    addr = token.slice(1, close);
    portPart = token.slice(close + 2); // skip `]:`
  } else {
    const lastColon = token.lastIndexOf(':');
    if (lastColon < 0) return null;
    addr = token.slice(0, lastColon);
    portPart = token.slice(lastColon + 1);
  }
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  // Strip an IPv6 zone id (`fe80::1%eth0`) — it says nothing about reach.
  const pct = addr.indexOf('%');
  return { addr: pct >= 0 ? addr.slice(0, pct) : addr, port };
}

/** Loopback in every spelling the host may report, including the whole
 *  `127.0.0.0/8` block (systemd-resolved binds `127.0.0.53`). */
function isLoopback(addr: string): boolean {
  return addr === '::1' || addr === 'localhost' || addr.startsWith('127.');
}

/** Parse the stdout of {@link LISTEN_SNAPSHOT_COMMAND}. */
export function parseListenSnapshot(stdout: string | undefined): ListenSnapshot {
  const binds = new Map<number, string[]>();
  for (const line of (stdout ?? '').split('\n')) {
    const token = line.trim();
    if (!token) continue;
    const parsed = splitBindToken(token);
    if (!parsed) continue;
    const seen = binds.get(parsed.port);
    if (seen) {
      if (!seen.includes(parsed.addr)) seen.push(parsed.addr);
    } else {
      binds.set(parsed.port, [parsed.addr]);
    }
  }
  return {
    ports: [...binds.keys()].sort((a, b) => a - b),
    binds,
    empty: binds.size === 0,
  };
}

/**
 * Is anything listening where this route forwards?
 *
 * `undefined` means the snapshot could not answer (it is empty) — the
 * caller must treat that as "unjudged", never as a dangling route.
 */
export function hasListener(
  snapshot: ListenSnapshot,
  host: string | undefined,
  port: number,
): boolean | undefined {
  if (snapshot.empty) return undefined;
  const addrs = snapshot.binds.get(port);
  if (!addrs) return false;
  if (addrs.some(a => WILDCARD_BINDS.has(a))) return true;
  const target = (host ?? '').trim();
  // No forward host recorded: the port is open somewhere, and that is
  // all this check claims to know.
  if (!target) return true;
  if (isLoopback(target)) return addrs.some(isLoopback);
  return addrs.includes(target);
}

/**
 * Take the snapshot through the agent, for callers outside the diagnose
 * run's own exec fan-out (the `delete_route` handler re-derives a
 * route's state at click time). Any failure yields an empty snapshot, so
 * the caller sees "unknown" rather than a fabricated "closed".
 */
export async function fetchListenSnapshot(node: string): Promise<ListenSnapshot> {
  try {
    // Imported lazily: this module is pulled in by the diagnose probe
    // registry, which the MCP server loads on its first tool call — and
    // the agent stack (ssh2 and friends) is far too heavy to drag onto
    // that path for a helper only the click-time re-derive uses.
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(node, LISTEN_SNAPSHOT_TIMEOUT_MS);
    const res = await agent.sendCommand(
      'exec',
      { command: LISTEN_SNAPSHOT_COMMAND },
      { timeoutMs: LISTEN_SNAPSHOT_TIMEOUT_MS },
    ) as { code?: number; stdout?: string };
    if (res?.code !== 0) return parseListenSnapshot('');
    return parseListenSnapshot(res.stdout);
  } catch {
    return parseListenSnapshot('');
  }
}
