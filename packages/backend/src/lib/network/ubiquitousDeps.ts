/**
 * Ubiquitous-dependency suppression (#1785).
 *
 * `auth` (Authelia SSO + the LLDAP directory it bundles) and `adguard`
 * (DNS) are semantic hubs: almost every managed service has a declared /
 * observed edge pointing at them. Rendered as graph edges, that fan-out is
 * the single biggest source of crossings in a flat node-link layout — it
 * can't be drawn planar.
 *
 * Instead of emitting those hub-spoke edges, we OMIT them and stamp a flag
 * on the source node:
 *   - `metadata.behindAuth = true`        — service sits behind Authelia/LLDAP
 *   - `metadata.usesDns = true`           — service depends on the DNS hub
 *   - `metadata.ubiquitousDeps = ['auth','dns']`  — generic list for the badge
 *
 * The hub NODES themselves (auth, adguard) stay — only the inbound fan-out
 * edges from other services are dropped. A service's OTHER real edges
 * (gateway, proxy, cross-service flows) are untouched. No information is
 * lost: the badge + legend convey "behind auth / uses DNS", and the
 * `kind`-toggle on the frontend can restore the hidden edges on demand.
 */
import type { NetworkNode, NetworkEdge } from './types';

/** Edge kinds eligible for suppression. We only ever drop dependency-style
 *  edges (a template `servicebay.dependencies` entry or an observed flow)
 *  pointing at a hub — never the infrastructure spine (gateway / proxy /
 *  manual), which carries distinct, non-ubiquitous meaning. */
const SUPPRESSIBLE_KINDS = new Set(['declared', 'observed']);

/** Base service names that act as ubiquitous hubs, mapped to the generic
 *  dependency token surfaced on the node badge. */
const HUB_BASENAMES: Record<string, 'auth' | 'dns'> = {
  auth: 'auth',
  lldap: 'auth',
  authelia: 'auth',
  adguard: 'dns',
};

/** Extract the base service name from a graph node id. Service nodes are
 *  `service-<name>` optionally prefixed with `<node>:` (remote hosts). The
 *  trailing `.service` suffix (if present) is stripped. */
function baseServiceName(nodeId: string): string | null {
  const afterPrefix = nodeId.includes(':') ? nodeId.slice(nodeId.indexOf(':') + 1) : nodeId;
  if (!afterPrefix.startsWith('service-')) return null;
  return afterPrefix.slice('service-'.length).replace(/\.service$/, '');
}

/** Classify a node as a hub by its id, returning the dependency token
 *  ('auth' | 'dns') or null. */
function hubTokenForNode(node: NetworkNode): 'auth' | 'dns' | null {
  const base = baseServiceName(node.id);
  if (base && HUB_BASENAMES[base]) return HUB_BASENAMES[base];
  return null;
}

export interface SuppressionResult {
  edges: NetworkEdge[];
  /** Count of suppressed hub-spoke edges (for logging / verification). */
  suppressed: number;
}

/**
 * Drop ubiquitous hub-spoke edges and stamp the source nodes with badge
 * flags. Mutates the passed `nodes` (sets metadata flags) and returns a new
 * filtered edge array — the input edge array is not mutated.
 */
export function suppressUbiquitousDeps(
  nodes: NetworkNode[],
  edges: NetworkEdge[],
): SuppressionResult {
  // Map node id → hub token so an edge lookup is O(1).
  const hubTokenById = new Map<string, 'auth' | 'dns'>();
  for (const node of nodes) {
    const token = hubTokenForNode(node);
    if (token) hubTokenById.set(node.id, token);
  }

  if (hubTokenById.size === 0) {
    return { edges, suppressed: 0 };
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  let suppressed = 0;

  const kept = edges.filter((edge) => {
    const token = hubTokenById.get(edge.target);
    // Keep the edge unless it's a suppressible dependency edge pointing at a
    // hub. A hub's OWN outbound edges, and non-dependency edges (gateway /
    // proxy / manual), are always kept.
    if (!token) return true;
    if (!SUPPRESSIBLE_KINDS.has(edge.kind ?? '')) return true;
    // Don't suppress a hub→hub edge (e.g. auth↔adguard) — both endpoints are
    // hubs; collapsing it would lose the only edge between the two hubs.
    if (hubTokenById.has(edge.source)) return true;

    // Suppress: stamp the source node and drop the edge.
    const source = nodeById.get(edge.source);
    if (source) {
      if (!source.metadata) source.metadata = {};
      if (token === 'auth') source.metadata.behindAuth = true;
      if (token === 'dns') source.metadata.usesDns = true;
      const existing = Array.isArray(source.metadata.ubiquitousDeps)
        ? (source.metadata.ubiquitousDeps as string[])
        : [];
      if (!existing.includes(token)) existing.push(token);
      source.metadata.ubiquitousDeps = existing;
    }
    suppressed += 1;
    return false;
  });

  return { edges: kept, suppressed };
}
