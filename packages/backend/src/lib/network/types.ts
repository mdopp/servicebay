export interface PortMapping {
  host: number;
  container: number;
  hostIp?: string;
  protocol?: string;
  source?: string;
}

export interface NetworkNode {
  id: string;
  type: string; // Relaxed type to allow 'pod', 'link', 'device' etc without strict enum issues during dev
  parentNode?: string;
  extent?: 'parent';
  label: string;
  subLabel?: string | null;
  hostname?: string | null;
  ip?: string | null;
  // ports property removed - use rawData.ports
  status: 'up' | 'down' | 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData?: any;
  node?: string;
}

/**
 * Edge provenance (#505). Lets the UI render — and the operator trust —
 * each edge for what it is:
 *   - `gateway` / `proxy` — infrastructure topology (FritzBox, nginx).
 *   - `observed`  — a real TCP flow seen on the host (`ss`); ground truth.
 *   - `declared`  — a template's `servicebay.dependencies` (author intent,
 *                   NOT observed traffic — rendered distinctly).
 *   - `inferred`  — derived from a service's env (`http://host:port` /
 *                   `host:port` naming another service) or, as a last
 *                   resort, a fallback anchor to the host so no card
 *                   floats disconnected (#2175). Rendered distinctly.
 *   - `manual`    — an operator-drawn edge (the `isManual` case).
 * Optional for backwards compatibility; absent is treated as a plain
 * structural edge.
 */
export type NetworkEdgeKind = 'gateway' | 'proxy' | 'observed' | 'declared' | 'inferred' | 'manual';

export interface NetworkEdge {
  id: string;
  source: string;
  target: string;
  label?: string; // e.g. "80 -> 3000"
  protocol: 'http' | 'https' | 'tcp' | 'udp';
  port: number;
  state: 'active' | 'inactive'; // For visualization (e.g. animated line)
  isManual?: boolean;
  /** Provenance discriminator (#505). See `NetworkEdgeKind`. */
  kind?: NetworkEdgeKind;
  /** For `observed` edges — when the flow was last seen + how many
   *  samples backed it, so the UI can show freshness / confidence. */
  lastSeen?: string;
  observedCount?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style?: any;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}
