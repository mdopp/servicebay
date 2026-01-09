export interface GatewayState {
  provider: 'fritzbox' | 'unifi' | 'mock';
  publicIp: string;
  internalIp?: string;
  upstreamStatus: 'up' | 'down';
  dnsServers?: string[];
  uptime?: number;
  lastUpdated: number;
  // Provider specific details can be added here or in a details bag
  deviceName?: string;
  connectionType?: string;
}

export interface GatewayProvider {
  name: string;
  init(): Promise<void>;
  poll(): Promise<Partial<GatewayState>>;
}
