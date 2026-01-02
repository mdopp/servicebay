export type NodeType = 'internet' | 'router' | 'proxy' | 'service' | 'container' | 'group';

export interface NetworkNode {
  id: string;
  type: NodeType;
  parentNode?: string;
  extent?: 'parent';
  label: string;
  subLabel?: string;
  ip?: string;
  ports: number[];
  status: 'up' | 'down' | 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData?: any;
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
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}
