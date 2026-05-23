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
  /** The original systemd unit identifier (e.g. `vaultwarden.service`).
   *  Used for matching/equality and as the canonical id. The UI should
   *  NOT render this directly — use `displayName` instead. (#844) */
  name: string;
  /** Pre-computed user-facing label. The backend strips `.service`,
   *  expands `nginx` → `Reverse Proxy (Nginx)`, etc. Frontend code
   *  must never `.replace('.service', '')` again. (#844) */
  displayName: string;
  /** Pre-split filename portion of `yamlPath` for display in chips and
   *  copy-to-clipboard affordances. Null when the file is not on disk. (#844) */
  yamlBasename: string | null;
  /** Pre-split filename portion of `kubePath`. Null when the unit is
   *  not a Quadlet `.kube` file. (#844) */
  kubeBasename: string | null;
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
