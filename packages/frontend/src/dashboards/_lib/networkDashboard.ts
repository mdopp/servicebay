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
import type { Position } from '@xyflow/react';
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
