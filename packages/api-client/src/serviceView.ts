// ServiceViewModel — the shape the dashboards consume after the
// backend transforms a `ServiceUnit` + twin state into something the
// UI can render. Phase 3.2 (#763) moved this type out of the
// frontend package to break the dep cycle:
//
//   api-client → src/lib/services/serviceViewModel.ts → (was) frontend → api-client
//
// Both halves now import the type from `@servicebay/api-client`.

import type { EnrichedContainer } from './agent';

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
