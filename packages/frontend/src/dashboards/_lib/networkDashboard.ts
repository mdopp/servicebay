/**
 * Type + helper extraction from NetworkDashboard.tsx (#961, step 2).
 *
 * Lifts the pure data shapes, stateless helpers, and edge-kind
 * styling constants out of the 2,189-LOC monolith. The xyflow
 * `CustomNode` / `CustomEdge` / `NetworkLegend` components stay in
 * the dashboard for now — the issue explicitly warns that the
 * canvas state needs careful split, and we don't take on
 * render-cycle risk without per-stage validation.
 */
import type { CSSProperties } from 'react';
import type { Position, Node, Edge } from '@xyflow/react';
import type { PortMapping } from '@servicebay/api-client';

/**
 * The node payload xyflow renders. Carries enough metadata that the
 * `CustomNode` can decide between gateway / service / internet
 * visuals, surface verified domains, and toggle expanded-subgraph
 * state via `onToggle`. Open via `Record<string, unknown>` so the
 * xyflow type machinery accepts arbitrary extra keys without a cast.
 */
export interface GraphNodeData extends Record<string, unknown> {
  id?: string;
  type: string;
  label: string;
  subLabel?: string;
  /** Node name (the ServiceBay-managed host, e.g. "Local"). */
  node?: string;
  hostname?: string;
  targetHandlePosition?: Position;
  sourceHandlePosition?: Position;
  collapsed?: boolean;
  onToggle?: (id: string, expanded?: boolean) => void;
  onCreateExternalLink?: (node: GraphNodeData) => void;
  status?: string;
  ip?: string;
  parentId?: string;
  summary?: {
    portMap?: PortMapping[];
    totalContainers?: number;
    activeContainers?: number;
    totalServices?: number;
    activeServices?: number;
    status?: string;
    verifiedDomains?: string[];
  };
  metadata?: {
    nodeIPs?: string[];
    verifiedDomains?: string[];
    externalTargetIp?: string;
    externalTargetPort?: number;
    description?: string;
    link?: string;
    stats?: {
      externalIP?: string;
      internalIP?: string;
      dnsServers?: string[];
    };
    [key: string]: unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData?: any;
}

/** Older port-mapping records that pre-date the strict shape, surfaced
 *  by some agent versions. The dashboard tolerates either shape and
 *  the rendering side falls back across the alternative names. */
export interface LegacyPortMapping extends PortMapping {
  IP?: string;
  host?: number;
  container?: number;
}

/** Gateway / device-level health payload the network dashboard
 *  consumes alongside the per-node twin state. */
export interface HealthData {
  connected?: boolean;
  externalIP?: string;
  uptime?: number;
  dnsServers?: string[];
  deviceLog?: string;
  [key: string]: unknown;
}

/** Derive the ServiceBay-managed node name (e.g. "Local") a graph
 *  node belongs to. Tries the rawData payload first (canonical),
 *  then the GraphNodeData.node hint, finally the `<node>:` prefix
 *  on the id. Returns trimmed string or undefined. */
export function deriveNodeNameFromGraph(node?: GraphNodeData | null): string | undefined {
  if (!node) return undefined;
  const raw = node.rawData as { nodeName?: string; node?: string } | undefined;
  const candidates = [
    typeof raw?.nodeName === 'string' ? raw.nodeName : undefined,
    typeof raw?.node === 'string' ? raw.node : undefined,
    typeof node.node === 'string' ? node.node : undefined,
    typeof node.id === 'string' && node.id.includes(':') ? node.id.split(':')[0] : undefined,
  ];

  const resolved = candidates.find((value): value is string => Boolean(value && value.trim().length > 0));
  return resolved?.trim();
}

/** Edit-page URL for a service node. Local-node services get the
 *  bare `/edit/<name>`; remote-node services keep the explicit
 *  `?node=<name>` qualifier so the form opens against the right
 *  managed host. */
export function buildServiceEditHref(node: GraphNodeData): string {
  const serviceName = typeof node.rawData?.name === 'string' ? node.rawData.name : '';
  if (!serviceName) return '/services';

  const base = `/edit/${encodeURIComponent(serviceName)}`;
  const nodeName = deriveNodeNameFromGraph(node);

  if (nodeName && nodeName.toLowerCase() !== 'local') {
    return `${base}?node=${encodeURIComponent(nodeName)}`;
  }

  return base;
}

// ────────────────────────────────────────────────────────────────────
// Focus / ego mode (#1786). Clicking a node reduces the map to that
// node's immediate neighbourhood — itself + its direct (1-hop)
// neighbours + the Internet→node path — and dims/hides everything
// else. The reduced subgraph re-layouts crossing-free and is the
// actual lever for reading a hub's relationships (auth/hermes/nginx
// are an unreadable knot in the full view).
// ────────────────────────────────────────────────────────────────────

/**
 * Compute the set of node ids that make up the ego-neighbourhood of
 * `focusId`: the focus node, its direct (1-hop) neighbours, and the
 * shortest Internet→focus path so the public-facing chain stays
 * visible. Edges are treated as undirected (the map's source/target
 * orientation is layout-direction, not reachability).
 *
 * Returns the keep-set; an empty set means "no focus" (caller shows
 * the full map).
 */
function buildUndirectedAdjacency(nodes: Node[], edges: Edge[]): Map<string, Set<string>> {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }
  return adjacency;
}

/** BFS shortest path between two ids over the adjacency, returned as the
 *  set of ids on the path (empty if unreachable). */
function shortestPathIds(
  adjacency: Map<string, Set<string>>,
  from: string,
  to: string,
): Set<string> {
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const next of adjacency.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      queue.push(next);
    }
  }
  const path = new Set<string>();
  if (!seen.has(to)) return path;
  let step: string | undefined = to;
  while (step) {
    path.add(step);
    step = prev.get(step);
  }
  return path;
}

/**
 * Hub classification for ego mode — mirrors the backend's
 * `ubiquitousDeps.ts` (#1785). The suppression there drops the
 * hub-spoke edges and stamps `behindAuth`/`usesDns` flags on the
 * source nodes instead, so the graph that reaches the frontend has no
 * `service→auth` / `service→dns` edges. Ego adjacency built from those
 * post-suppression edges therefore can't see the hub fan-in (#1792).
 * We re-derive the hub relationship from the flags below.
 *
 * `service-<name>` ids may carry a `<node>:` remote-host prefix and a
 * trailing `.service`; strip both to get the base name.
 */
const HUB_BASENAMES: Record<string, 'auth' | 'dns'> = {
  auth: 'auth',
  lldap: 'auth',
  authelia: 'auth',
  adguard: 'dns',
};

function hubTokenForNodeId(nodeId: string): 'auth' | 'dns' | null {
  const afterPrefix = nodeId.includes(':') ? nodeId.slice(nodeId.indexOf(':') + 1) : nodeId;
  if (!afterPrefix.startsWith('service-')) return null;
  const base = afterPrefix.slice('service-'.length).replace(/\.service$/, '');
  return HUB_BASENAMES[base] ?? null;
}

/** Read the suppressed-dependency tokens (#1785) a node carries via its
 *  `behindAuth` / `usesDns` flags, normalised to the hub token. */
function suppressedDepTokens(node: Node): Set<'auth' | 'dns'> {
  const metadata = (node.data as { metadata?: { behindAuth?: unknown; usesDns?: unknown } } | undefined)
    ?.metadata;
  const tokens = new Set<'auth' | 'dns'>();
  if (metadata?.behindAuth === true) tokens.add('auth');
  if (metadata?.usesDns === true) tokens.add('dns');
  return tokens;
}

/**
 * #1792 — restore the ubiquitous hub relationships that #1785 suppressed
 * out of the edge list, deriving them from the node flags instead. Adds the
 * relevant ids to `keep` in place:
 *  - focus IS a hub (auth/dns): add every service carrying the matching flag
 *    (its fan-in), so the hub's ego isn't empty.
 *  - focus is a normal service: add the hub node(s) it depends on via its
 *    own flags, so a badge-only service isn't isolated.
 */
function addSuppressedHubNeighbours(nodes: Node[], focusId: string, keep: Set<string>): void {
  const focusHubToken = hubTokenForNodeId(focusId);
  if (focusHubToken) {
    for (const n of nodes) {
      if (suppressedDepTokens(n).has(focusHubToken)) keep.add(n.id);
    }
    return;
  }
  const focusNode = nodes.find((n) => n.id === focusId);
  const wantedTokens = focusNode ? suppressedDepTokens(focusNode) : new Set<'auth' | 'dns'>();
  if (wantedTokens.size === 0) return;
  for (const n of nodes) {
    const token = hubTokenForNodeId(n.id);
    if (token && wantedTokens.has(token)) keep.add(n.id);
  }
}

export function computeEgoNodeIds(
  nodes: Node[],
  edges: Edge[],
  focusId: string | null | undefined,
): Set<string> {
  if (!focusId) return new Set();
  if (!nodes.some((n) => n.id === focusId)) return new Set();

  const adjacency = buildUndirectedAdjacency(nodes, edges);

  const keep = new Set<string>([focusId]);
  // Direct neighbours (1 hop).
  for (const n of adjacency.get(focusId) ?? []) keep.add(n);

  addSuppressedHubNeighbours(nodes, focusId, keep);

  // Shortest path Internet→focus (BFS) so the public chain is shown
  // even when the gateway/proxy hops are >1 away from the focus node.
  const internet = nodes.find((n) => (n.data as { type?: string } | undefined)?.type === 'internet');
  if (internet && internet.id !== focusId) {
    for (const id of shortestPathIds(adjacency, internet.id, focusId)) keep.add(id);
  }

  return keep;
}

// ────────────────────────────────────────────────────────────────────
// #2119 — topology signature + in-place data merge.
//
// The map polls every 1–3s. Re-running the ELK layout (and resetting node
// positions + the pan/zoom viewport) on every poll made the map impossible
// to navigate. The fix is to only re-layout when the *topology* actually
// changed — and otherwise merge the fresh status/health data onto the
// already-laid-out nodes, keeping their `position`.
// ────────────────────────────────────────────────────────────────────

/**
 * A stable signature of what would change the layout: the set of node ids,
 * the set of edge ids (source→target pairs), plus the collapsed-group set and
 * the active focus node. Order-independent (ids are sorted) so a poll that
 * returns the same topology in a different array order yields the SAME
 * signature → no re-layout. Status / health / label changes do NOT move a
 * node, so they are deliberately excluded from the signature.
 */
export function topologyLayoutSignature(
  nodes: Node[],
  edges: Edge[],
  collapsed?: Set<string> | null,
  focus?: string | null,
): string {
  const nodeIds = nodes.map((n) => n.id).sort();
  // Use source→target (not the volatile generated edge id) so a stable
  // topology keeps a stable edge signature across polls.
  const edgeKeys = edges.map((e) => `${e.source}->${e.target}`).sort();
  const collapsedIds = collapsed ? Array.from(collapsed).sort() : [];
  return JSON.stringify({
    n: nodeIds,
    e: edgeKeys,
    c: collapsedIds,
    f: focus ?? null,
  });
}

/**
 * Merge a freshly-fetched graph onto the currently-laid-out nodes WITHOUT
 * re-running the layout: for every existing node, carry its `position` (and
 * layout-affecting `style` width/height) forward while taking the new `data`
 * (status / metadata / label). Nodes that vanished are dropped; nodes that
 * appeared are kept at their incoming position (shouldn't happen when the
 * topology signature is unchanged, but handled defensively). Edges adopt the
 * fresh styling/label but are matched to the laid-out edge by source→target
 * so the routed `points`/`hops`/positions survive the poll.
 */
export function mergeGraphPreservingPositions<TNode extends Node, TEdge extends Edge>(
  laidOutNodes: TNode[],
  laidOutEdges: TEdge[],
  freshNodes: TNode[],
  freshEdges: TEdge[],
): { nodes: TNode[]; edges: TEdge[] } {
  const laidOutById = new Map(laidOutNodes.map((n) => [n.id, n]));
  const nodes = freshNodes.map((fresh) => {
    const prev = laidOutById.get(fresh.id);
    if (!prev) return fresh;
    return {
      ...prev,
      data: fresh.data,
      // Keep the laid-out position + layout-sized style; refresh everything
      // else (className etc.) from the fresh node.
      position: prev.position,
      style: prev.style,
    } as TNode;
  });

  const laidOutEdgeByPair = new Map(
    laidOutEdges.map((e) => [`${e.source}->${e.target}`, e]),
  );
  const edges = freshEdges.map((fresh) => {
    const prev = laidOutEdgeByPair.get(`${fresh.source}->${fresh.target}`);
    if (!prev) return fresh;
    // Keep the routed geometry (data.points / hops / lpos, the generated id,
    // sourceHandle/targetHandle) from the laid-out edge; refresh styling.
    return {
      ...prev,
      label: fresh.label,
      style: fresh.style,
      animated: fresh.animated,
      data: { ...(prev.data ?? {}), ...(fresh.data ?? {}) },
    } as TEdge;
  });

  return { nodes, edges };
}

// ────────────────────────────────────────────────────────────────────
// Edge-kind styling (#813). The backend stamps each edge with `kind`
// (gateway | proxy | observed | declared | manual). The map must
// render "I just saw this TCP flow" (observed, solid blue) and "the
// template author says this exists" (declared, dashed slate) so an
// operator never confuses the two. Down-target dashes still win —
// service-down is a stronger signal than provenance.
// ────────────────────────────────────────────────────────────────────
export const DEFAULT_EDGE_COLOR = 'rgba(148, 163, 184, 0.2)';
export const DOWN_EDGE_COLOR = '#ef4444';
export const DOWN_EDGE_DASHES = '6 3';

export const DECLARED_EDGE_COLOR = '#64748b'; // Slate
export const DECLARED_EDGE_DASHES = '4 4';
export const OBSERVED_EDGE_COLOR = '#3b82f6'; // Clean blue

export function styleForEdgeKind(
  kind: string | undefined,
  base: CSSProperties | undefined,
): CSSProperties | undefined {
  if (kind === 'declared') {
    return {
      ...(base || {}),
      stroke: DECLARED_EDGE_COLOR,
      strokeDasharray: DECLARED_EDGE_DASHES,
    };
  }
  if (kind === 'observed') {
    return {
      ...(base || {}),
      stroke: OBSERVED_EDGE_COLOR,
    };
  }
  return base;
}

export function labelForEdgeKind(
  kind: string | undefined,
  baseLabel: string | undefined,
): string | undefined {
  if (kind === 'declared') {
    return baseLabel ? `${baseLabel} (declared)` : 'declared';
  }
  return baseLabel;
}

// ---------------------------------------------------------------------------
// Orthogonal edge path geometry (#1782 routing, #1784 line-hops)
// ---------------------------------------------------------------------------

type XY = { x: number; y: number };

/** #1782 — small rounded corners (quadratic `Q`) at each bend so the
 *  "circuit-board" orthogonal routes read cleanly without hard pixel corners. */
const ORTHOGONAL_CORNER_RADIUS = 8;

/** #1784 — wire-hop radius: at a crossing the horizontal run lifts into a small
 *  semicircular ∩ arc so it reads as an overpass, not a junction. */
const HOP_RADIUS = 6;

/** Tolerance (px) for treating a segment as horizontal / a hop as on-run. */
const RUN_EPS = 1.5;

/**
 * #1784 — emit a horizontal run from `fromX` to `toX` (shared `y`), inserting a
 * ∩ bump at each hop point inside the run. Hops are filtered to this run's
 * x-span + y and ordered along the direction of travel, so a right→left run
 * still hops in path order. Each bump is one arc (`A r r 0 0 sweep`) lifting
 * "up" (−y); sweep is chosen so both travel directions stay a ∩.
 */
function appendHorizontalRunWithHops(fromX: number, toX: number, y: number, hops: XY[]): string {
  const forward = toX >= fromX;
  const lo = Math.min(fromX, toX);
  const hi = Math.max(fromX, toX);
  const onRun = hops
    .filter(h => Math.abs(h.y - y) <= RUN_EPS && h.x > lo + HOP_RADIUS && h.x < hi - HOP_RADIUS)
    .sort((a, b) => (forward ? a.x - b.x : b.x - a.x));

  let path = '';
  for (const h of onRun) {
    const enter = forward ? h.x - HOP_RADIUS : h.x + HOP_RADIUS;
    const exit = forward ? h.x + HOP_RADIUS : h.x - HOP_RADIUS;
    const sweep = forward ? 1 : 0;
    path += ` L ${enter},${y} A ${HOP_RADIUS} ${HOP_RADIUS} 0 0 ${sweep} ${exit},${y}`;
  }
  path += ` L ${toX},${y}`;
  return path;
}

/**
 * #1782/#1784 — build an orthogonal SVG path from ELK's routing `points`,
 * rounding each bend and inserting ∩ line-hops (`hops`) on horizontal runs.
 * Returns the path plus the polyline midpoint for the port label.
 */
export function buildOrthogonalPath(
  points: XY[],
  hops: XY[] = [],
): { path: string; labelX: number; labelY: number } {
  const start = points[0];
  let path = `M ${start.x},${start.y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];

    // Stop short of the corner, round through it, resume along the outgoing
    // segment — capped at half each leg so short legs don't overshoot.
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y) || 1;
    const r = Math.min(ORTHOGONAL_CORNER_RADIUS, inLen / 2, outLen / 2);

    const before = {
      x: corner.x - ((corner.x - prev.x) / inLen) * r,
      y: corner.y - ((corner.y - prev.y) / inLen) * r,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };

    // #1784 — a horizontal incoming leg may carry hops up to the corner round.
    if (hops.length > 0 && Math.abs(prev.y - corner.y) <= RUN_EPS) {
      path += appendHorizontalRunWithHops(prev.x, before.x, corner.y, hops);
    } else {
      path += ` L ${before.x},${before.y}`;
    }
    path += ` Q ${corner.x},${corner.y} ${after.x},${after.y}`;
  }

  const end = points[points.length - 1];
  const lastBend = points[points.length - 2];
  if (hops.length > 0 && points.length >= 2 && Math.abs(lastBend.y - end.y) <= RUN_EPS) {
    path += appendHorizontalRunWithHops(lastBend.x, end.x, end.y, hops);
  } else {
    path += ` L ${end.x},${end.y}`;
  }

  const mid = points[Math.floor(points.length / 2)];
  return { path, labelX: mid.x, labelY: mid.y };
}
