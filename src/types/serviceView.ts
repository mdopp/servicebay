import { EnrichedContainer } from '@/lib/agent/types';

export interface ServicePort {
  host?: string;
  container?: string;
  hostIp?: string;
  protocol?: string;
  source?: string;
}

export interface ServiceVolume {
  host: string;
  container: string;
  mode?: string;
}

export type ServiceType = 'kube' | 'container' | 'link' | 'gateway';

export interface ServiceViewModel {
  name: string;
  id?: string;
  description?: string | null;
  nodeName?: string;
  active: boolean;
  status?: string;
  activeState?: string;
  subState?: string;
  kubePath?: string | null;
  yamlPath?: string | null;
  type: ServiceType;
  ports: ServicePort[];
  volumes?: ServiceVolume[];
  monitor?: boolean;
  labels?: Record<string, string>;
  verifiedDomains?: string[];
  externalIP?: string;
  internalIP?: string;
  dnsServers?: string[];
  uptime?: number;
  url?: string;
  ipTargets?: string[];
  isManaged?: boolean;
  containerIds?: string[];
  attachedContainers?: EnrichedContainer[];
}
