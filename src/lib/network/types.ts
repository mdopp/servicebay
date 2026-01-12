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

export interface NetworkEdge {
  id: string;
  source: string;
  target: string;
  label?: string; // e.g. "80 -> 3000"
  protocol: 'http' | 'https' | 'tcp' | 'udp';
  port: number;
  state: 'active' | 'inactive'; // For visualization (e.g. animated line)
  isManual?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style?: any;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}
