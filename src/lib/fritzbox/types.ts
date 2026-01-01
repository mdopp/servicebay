export interface PortMapping {
  remoteHost: string;
  externalPort: number;
  protocol: 'TCP' | 'UDP';
  internalPort: number;
  internalClient: string;
  enabled: boolean;
  description: string;
  leaseDuration: number;
}

export interface FritzBoxStatus {
  connected: boolean;
  externalIP: string;
  uptime: number;
  portMappings: PortMapping[];
}
