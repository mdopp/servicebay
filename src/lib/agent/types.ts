export interface SystemResources {
  cpuUsage: number; // Percentage 0-100
  memoryUsage: number; // Bytes
  totalMemory: number; // Bytes
  diskUsage: number; // Percentage 0-100
  os?: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    uptime: number;
  };
  disks?: {
    device: string;
    mountpoint: string;
    total: number;
    used: number;
    free: number;
    type: string;
  }[];
  network?: Record<string, {
    address: string;
    family: string; // IPv4 or IPv6
    internal: boolean;
  }[]>;
}

export interface PortMapping {
  hostPort: number;
  containerPort: number;
  host_port?: number;
  container_port?: number;
  protocol: string;
}

export interface Volume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string>;
  Options: Record<string, string>;
  Scope: string;
  Node?: string; // Implicitly set by backend based on origin
  UsedBy: { id: string; name: string }[];
  Anonymous: boolean;
}

export interface EnrichedContainer {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  created: number;
  ports: PortMapping[];
  mounts: { // For volume mapping
      Type: string;
      Name?: string;
      Source: string;
      Destination: string;
      Driver?: string;
      Mode: string;
      RW: boolean;
      Propagation: string;
  }[];
  labels: Record<string, string>;
  networks: string[];
  podId?: string;
  podName?: string;
  isInfra?: boolean;
  pid?: number;
}

export interface ServiceUnit {
  name: string;
  activeState: string; // active, inactive, activating, deactivating, failed
  subState: string; // running, dead, exited, etc.
  loadState: string; // loaded, not-found, bad-setting
  description: string;
  path: string; // Path to unit file
  fragmentPath?: string; // Path to the unit file on disk
  active?: boolean;
  isReverseProxy?: boolean;
  isServiceBay?: boolean;
}

export interface ProxyRoute {
    host: string;
    targetService: string;
    targetPort: number;
    ssl: boolean;
}

export interface WatchedFile {
    path: string;
    content: string; // Text content (systemd unit, YAML, etc)
    modified: number;
}

export interface NodeStateSnapshot {
  resources: SystemResources | null;
  containers: EnrichedContainer[];
  services: ServiceUnit[];
  volumes: Volume[];
  files: Record<string, WatchedFile>; // Key is generic path, typically ~/.config/containers/systemd/...
  proxy?: ProxyRoute[];
  timestamp: number;
}

export type AgentMessage =
  | { type: 'SYNC_PARTIAL'; payload: Partial<NodeStateSnapshot> & { initialSyncComplete?: boolean } }
  | { type: 'HEARTBEAT'; timestamp: number }
  | { type: 'SYNC_DIFF'; payload: Partial<NodeStateSnapshot> }; // Kept for future diff logic
