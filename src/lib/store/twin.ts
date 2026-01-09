import { EnrichedContainer, ServiceUnit, SystemResources, Volume, WatchedFile, ProxyRoute, PortMapping } from '../agent/types';

export interface NodeTwin {
  connected: boolean;
  lastSync: number;
  initialSyncComplete: boolean; // Indicator for first full sync
  resources: SystemResources | null;
  containers: EnrichedContainer[];
  services: ServiceUnit[];
  volumes: Volume[];
  files: Record<string, WatchedFile>;
  proxy?: ProxyRoute[];
}

export interface GatewayState {
  provider: 'fritzbox' | 'unifi' | 'mock';
  publicIp: string;
  internalIp?: string;
  upstreamStatus: 'up' | 'down';
  dnsServers?: string[];
  uptime?: number;
  portMappings?: PortMapping[];
  lastUpdated: number;
}

export interface ProxyRoute {
  host: string;
  targetService: string;
  targetPort: number;
  ssl: boolean;
}

export interface ProxyState {
  provider: 'nginx' | 'traefik' | 'caddy';
  routes: ProxyRoute[];
}

export class DigitalTwinStore {
  private static instance: DigitalTwinStore;

  public nodes: Record<string, NodeTwin> = {};
  
  public gateway: GatewayState = {
    provider: 'mock',
    publicIp: '0.0.0.0',
    upstreamStatus: 'down',
    lastUpdated: 0
  };

  public proxy: ProxyState = {
    provider: 'nginx',
    routes: []
  };

  private listeners: Array<() => void> = [];

  private constructor() {}

  public static getInstance(): DigitalTwinStore {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const globalStore = global as any;
    if (!globalStore.__DIGITAL_TWIN__) {
      globalStore.__DIGITAL_TWIN__ = new DigitalTwinStore();
    }
    return globalStore.__DIGITAL_TWIN__;
  }

  public registerNode(nodeId: string) {
    if (!this.nodes[nodeId]) {
      this.nodes[nodeId] = {
        connected: false,
        lastSync: 0,
        initialSyncComplete: false,
        resources: null,
        containers: [],
        services: [],
        volumes: [],
        files: {},
        proxy: []
      };
      this.notifyListeners();
    }
  }

  public updateNode(nodeId: string, data: Partial<NodeTwin>) {
    if (!this.nodes[nodeId]) {
      this.registerNode(nodeId);
    }

    // Validation
    if (data.containers !== undefined && !Array.isArray(data.containers)) {
        console.error(`[TwinStore] Invalid containers update for ${nodeId} (expected Array):`, typeof data.containers);
        delete data.containers;
    }
    if (data.services !== undefined && !Array.isArray(data.services)) {
        console.error(`[TwinStore] Invalid services update for ${nodeId} (expected Array):`, typeof data.services);
        delete data.services;
    }
    if (data.volumes !== undefined && !Array.isArray(data.volumes)) {
        console.error(`[TwinStore] Invalid volumes update for ${nodeId} (expected Array):`, typeof data.volumes);
        delete data.volumes;
    }
    if (data.proxy !== undefined && !Array.isArray(data.proxy)) {
         console.error(`[TwinStore] Invalid proxy update for ${nodeId} (expected Array):`, typeof data.proxy);
         delete data.proxy;
    }

    // Files is a Record (Object)
    if (data.files !== undefined && (typeof data.files !== 'object' || data.files === null || Array.isArray(data.files))) {
         console.error(`[TwinStore] Invalid files update for ${nodeId} (expected Object):`, typeof data.files);
         delete data.files;
    }
    
    this.nodes[nodeId] = {
      ...this.nodes[nodeId],
      ...data,
      lastSync: Date.now()
    };
    
    this.notifyListeners();
  }

  public updateGateway(data: Partial<GatewayState>) {
      this.gateway = {
          ...this.gateway,
          ...data,
          lastUpdated: Date.now()
      };
      this.notifyListeners();
  }

  public setNodeConnection(nodeId: string, connected: boolean) {
    if(!this.nodes[nodeId]) this.registerNode(nodeId);
    this.nodes[nodeId].connected = connected;
    this.notifyListeners();
  }

  public subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners() {
    this.listeners.forEach(l => l());
  }
  
  public getSnapshot() {
      return {
          nodes: this.nodes,
          gateway: this.gateway,
          proxy: this.proxy
      }
  }
}
