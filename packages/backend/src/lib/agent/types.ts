import type { QuadletDirectives } from '@/lib/quadlet/parser';

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
  cpu?: {
    model: string;
    cores: number;
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
  /** GPUs detected on the host. Empty / undefined on hosts without
   *  one. Memory fields are in bytes (consistent with disks). For now
   *  populated by nvidia-smi only; other vendors can hang off the
   *  same shape later. */
  gpus?: {
    vendor: string;       // "nvidia" today; future "amd" / "intel"
    name: string;         // e.g. "NVIDIA GeForce RTX 2000 Ada Generation"
    uuid?: string | null;
    driver?: string | null;
    memoryTotal?: number | null;  // bytes
    memoryUsed?: number | null;   // bytes
    utilizationGpu?: number | null;     // 0..100 %
    utilizationMemory?: number | null;  // 0..100 %
    temperatureC?: number | null;
    powerDraw?: number | null;          // watts
    powerLimit?: number | null;         // watts
  }[];
}

export interface PortMapping {
  hostPort?: number;
  containerPort?: number;
  protocol: string;
  hostIp?: string; // Bind IP on host (usually 0.0.0.0)
  targetIp?: string; // For Gateway: Internal IP the port is forwarded to
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
  isHostNetwork?: boolean;
  podId?: string;
  podName?: string;
  isInfra?: boolean;
  pid?: number;
  verifiedDomains?: string[]; // Enriched by TwinStore (Nginx/Traefik Reverse Lookup)
  nodeName?: string; // Assigned client-side when containers are associated with a node context
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
  isManaged?: boolean; // True if backed by a .kube file (ServiceBay Stack)
  isPrimaryProxy?: boolean; // Managed by TwinStore (Consistency)
  associatedContainerIds?: string[]; // IDs of containers managed by this service (SINGLE SOURCE OF TRUTH)
  ports?: PortMapping[];
  
  // Quadlet/Systemd Relationship Fields (discovered via QuadletParser)
  requires?: string[]; // Hard dependencies from Requires= directive
  after?: string[]; // Ordering constraints from After= directive
  wants?: string[]; // Soft dependencies from Wants= directive
  bindsTo?: string[]; // Bidirectional dependencies from BindsTo= directive
  
  // Quadlet-specific references
  podReference?: string; // Pod name referenced by Pod= directive (for .container files)
  publishedPorts?: Array<{
    hostPort?: number;
    containerPort?: number;
    protocol?: string;
  }>; // Ports from PublishPort= directive (for .pod files)
  quadletDirectives?: QuadletDirectives; // Raw parsed directives for downstream consumers
  
  // Source type for better categorization
  quadletSourceType?: 'container' | 'pod' | 'kube' | 'service';
  
  // Derived/Enriched Properties (calculated by TwinStore)
  effectiveHostNetwork?: boolean;
  proxyConfiguration?: unknown; // Nginx/Traefik Routing Table (Enriched)
  verifiedDomains?: string[]; // Enriched by TwinStore (Nginx/Traefik Reverse Lookup)
  /**
   * Latest result from the continuous health probe (#626). Populated by
   * the `serviceHealth` poller from each template's `servicebay.healthcheck`
   * annotation. Single source of truth that Phase 3B migrates `settleWait`,
   * diagnose probes, and per-template `wait_for_X` helpers onto.
   *
   * Stored in `DigitalTwinStore.serviceHealth` (a side-map keyed by
   * `nodeName + serviceName`) and re-attached to each service on every
   * twin update — without that, the agent's periodic services-array
   * replacement would wipe this field between probe runs.
   */
  health?: ServiceHealth;
}

export interface ServiceHealth {
  /** `true` when the probe most recently returned a healthy response.
   *  Templates can also surface `degraded: true` to signal "running but
   *  in a soft-fail state" — readers should treat that as `ready: true`
   *  for gating purposes but show a warning in the UI. */
  ready: boolean;
  degraded?: boolean;
  /** ISO timestamp of when the probe last completed (success or fail). */
  lastCheckedAt: string;
  /** Operator-facing message — typically the response body's `message`
   *  field, or the network error on probe failure. Bounded so a chatty
   *  service can't bloat the twin. */
  message?: string;
  /** Per-dependency status the service reports about its own backends
   *  (e.g. Authelia reports lldap, smtp). Strict `ok`/`degraded`/
   *  `unreachable` so a typo on the service side doesn't silently drop
   *  signal. */
  deps?: Record<string, 'ok' | 'degraded' | 'unreachable'>;
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
  | { type: 'HEARTBEAT'; timestamp: number };
