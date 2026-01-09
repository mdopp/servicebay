import { EnrichedContainer, ServiceUnit, SystemResources, Volume, WatchedFile, ProxyRoute } from '../agent/types';

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
