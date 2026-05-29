import path from 'path';
import { EnrichedContainer, ServiceUnit, ServiceHealth, SystemResources, Volume, WatchedFile, ProxyRoute, PortMapping } from '../agent/types';
import { logger } from '../logger';
import type { AgentHealth } from '../agent/handler';
import type { ServiceBundle } from '../unmanaged/bundleShared';
import { sanitizeBundleName } from '../unmanaged/bundleShared';
import { buildServiceBundlesForNode } from '../unmanaged/bundleBuilder';
import { NodeTwinUpdateSchema } from './schema';
import {
  extractPortsFromKubeYaml,
  extractPortsFromQuadletContainer,
} from './twinPortExtraction';

const normalizeNameToken = (value?: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const stripped = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    let normalized = sanitizeBundleName(stripped);
    if (!normalized) return null;
    normalized = normalized.replace(/^systemd-/, '');
    normalized = normalized.replace(/-pod$/, '');
    return normalized || null;
};

const collectContainerNameTokens = (container: EnrichedContainer): string[] => {
    const tokens = new Set<string>();
    const register = (value?: string | null) => {
        const normalized = normalizeNameToken(value);
        if (normalized) tokens.add(normalized);
    };
    register(container.podName);
    if (container.labels) {
        register(container.labels['io.podman.pod.name']);
        register(container.labels['io.kubernetes.pod.name']);
        register(container.labels['io.podman.compose.project']);
    }
    (container.names || []).forEach(name => register(name));
    return Array.from(tokens);
};

export interface MigrationHistoryEntry {
    id: string;
    timestamp: string;
    actor: string;
    targetName: string;
    nodeName: string;
    bundleSize: number;
    services: Array<{
        name: string;
        sourcePath?: string;
        unitFile?: string;
        containerIds: string[];
    }>;
    backupArchive?: string;
    status: 'success' | 'failed' | 'rolled_back';
    error?: string;
}

export interface NodeTwin {
  connected: boolean;
  lastSync: number;
  initialSyncComplete: boolean; // Indicator for first full sync
  resources: SystemResources | null;
  containers: EnrichedContainer[];
  services: ServiceUnit[];
  volumes: Volume[];
  files: Record<string, WatchedFile>;
  // Per-node reverse-proxy route list. Distinct from
  // `DigitalTwinStore.proxyState` (provider + aggregated global view);
  // the two used to share the name `proxy` which made readers confusing
  // (#593).
  proxyRoutes?: ProxyRoute[];
  health?: AgentHealth;
  nodeIPs: string[];
  unmanagedBundles: ServiceBundle[];
    dismissedBundles: string[];
    history: MigrationHistoryEntry[];
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

export interface ProxyState {
  provider: 'nginx' | 'traefik' | 'caddy';
  routes: ProxyRoute[];
}

export class DigitalTwinStore {
  private static instance: DigitalTwinStore;
    private static readonly HISTORY_LIMIT = 25;

  public nodes: Record<string, NodeTwin> = {};
  
  public gateway: GatewayState = {
    provider: 'mock',
    publicIp: '0.0.0.0',
    upstreamStatus: 'down',
    lastUpdated: 0
  };

  // Aggregated reverse-proxy state across all nodes (provider +
  // unioned route list). Distinct from each `NodeTwin.proxyRoutes`
  // (per-node raw list — these are inputs to the aggregation below).
  // See #593.
  public proxyState: ProxyState = {
    provider: 'nginx',
    routes: []
  };

  private listeners: Array<() => void> = [];
  private staticPortsCache = new Map<string, { contentKey: string; ports: PortMapping[] }>();

  // Per-node debounce timers for unmanaged-bundle rebuilds (#1036).
  // Bundle discovery is O(containers × services) and was firing inside
  // every SYNC_PARTIAL; debouncing collapses a burst into one rebuild.
  private bundleRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  public bundleRebuildDebounceMs = 5_000; // public for tests


  /**
   * Health-probe results keyed by `nodeId → serviceName → ServiceHealth`.
   * Source of truth for `ServiceUnit.health` (#626). Held out-of-band
   * because the agent periodically replaces `NodeTwin.services` wholesale;
   * re-attaching from this side-map after each `updateNode` keeps the
   * field stable across syncs without forcing the agent to know about it.
   */
  private serviceHealth: Record<string, Record<string, ServiceHealth>> = {};

  private constructor() {}

    public static getInstance(): DigitalTwinStore {
        if (!DigitalTwinStore.instance) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const globalStore = global as any;
            if (!globalStore.__DIGITAL_TWIN__) {
                const id = Math.random().toString(36).substring(7);
                // logger.info('TwinStore', `Creating NEW Singleton (PID: ${process.pid}) | Instance: ${id}`);
                globalStore.__DIGITAL_TWIN__ = new DigitalTwinStore();
                globalStore.__DIGITAL_TWIN__.instanceId = id;
            }
            DigitalTwinStore.instance = globalStore.__DIGITAL_TWIN__;
        }
        return DigitalTwinStore.instance;
    }

  public instanceId: string = "unknown";

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
        proxyRoutes: [],
        nodeIPs: [],
                    unmanagedBundles: [],
                                        dismissedBundles: [],
        history: []
      };
      this.notifyListeners();
    }
  }

  public updateNode(nodeId: string, data: Partial<NodeTwin>) {
    if (!this.nodes[nodeId]) {
      this.registerNode(nodeId);
    }

    // Single validated entry point: top-level shape (array vs object) is enforced
    // here, not deep contents — the agent shapes inner objects before pushing.
    // Invalid keys are dropped rather than throwing so a single bad field can't
    // crash the store under fuzzed input.
    const parsed = NodeTwinUpdateSchema.safeParse(data);
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      for (const key of Object.keys(flat)) {
        logger.error('TwinStore', `Invalid ${key} update for ${nodeId}:`, flat[key]);
        delete (data as Record<string, unknown>)[key];
      }
    }

    // Normalization: Ensure ports are PortMapping objects
    if (data.containers) {
          data.containers.forEach(c => {
              if (c.ports && Array.isArray(c.ports)) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  c.ports = c.ports.map((p: any) => normalizePort(p));
              }

              const imageName = typeof c.image === 'string' ? c.image.toLowerCase() : '';
              const firstName = Array.isArray(c.names) && c.names.length > 0 ? c.names[0] : '';
              if (imageName.includes('podman-pause') ||
                  (!imageName && /^[0-9a-f]+-service$/.test(firstName))) {
                  c.isInfra = true;
              }
          });
    }
    if (data.services) {
          data.services.forEach(s => {
              if (s.ports && Array.isArray(s.ports)) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  s.ports = s.ports.map((p: any) => normalizePort(p));
              }
          });
    }

    // CONSISTENCY ENFORCEMENT: Identify Authoritative Proxy Service
    // We do this ONCE during the update to establish the Single Source of Truth
    if (data.services) {
        const containerSnapshot = data.containers ?? this.nodes[nodeId]?.containers ?? [];

        data.services.forEach(s => {
            s.isReverseProxy = this.isReverseProxyService(s, containerSnapshot);
            s.isServiceBay = this.isServiceBayService(s, containerSnapshot);
            delete s.isPrimaryProxy;
        });

        // 2. Select the winner
        const primary = data.services
            .filter(s => s.isReverseProxy)
            .sort((a, b) => {
                 // Active wins
                 if (a.active && !b.active) return -1;
                 if (!a.active && b.active) return 1;
                 // Standard name wins
                 const standards = ['nginx', 'nginx', 'traefik', 'caddy'];
                 const isStandardA = standards.includes(a.name);
                 const isStandardB = standards.includes(b.name);
                 if (isStandardA && !isStandardB) return -1;
                 if (!isStandardA && isStandardB) return 1;
                 return 0;
            })[0];
        
        if (primary) {
            primary.isPrimaryProxy = true;
            // console.log(`[TwinStore] Selected Authoritative Proxy for ${nodeId}: ${primary.name}`);
        }
    }

    // CONSISTENCY ENFORCEMENT: Link Services to Containers
    const targetServices = data.services || this.nodes[nodeId]?.services || [];
    const targetContainers = data.containers || this.nodes[nodeId]?.containers || [];
    const containerNameTokenCache = new Map<string, string[]>();
    const getContainerTokens = (container: EnrichedContainer): string[] => {
        if (!containerNameTokenCache.has(container.id)) {
            containerNameTokenCache.set(container.id, collectContainerNameTokens(container));
        }
        return containerNameTokenCache.get(container.id)!;
    };

    if (targetServices.length > 0 && targetContainers.length > 0) {
        targetServices.forEach(s => {
             // 1. Strict Label Match (PODMAN_SYSTEMD_UNIT)
             const labelMatches = targetContainers.filter(c => c.labels?.['PODMAN_SYSTEMD_UNIT'] === `${s.name}.service`);
             
             // 2. Pod Match (If service name matches Pod name)
             const podMatches = targetContainers.filter(c => {
                 if (!c.podName) return false;
                 // container.podName is usually just the name.
                 return c.podName === s.name || c.podName === `${s.name}-pod`;
             });

             // 3. Strict Name Match (Fallback for basic containers)
             const nameMatches = targetContainers.filter(c => {
                 // Strict: name equals s.name or systemd-s.name
                 return c.names.some(n => {
                     const name = n.startsWith('/') ? n.slice(1) : n;
                     return name === s.name || name === `systemd-${s.name}`;
                 });
             });

             // Merge unique IDs
             const allIds = new Set([
                 ...(s.associatedContainerIds || []),
                 ...labelMatches.map(c => c.id),
                 ...podMatches.map(c => c.id),
                 ...nameMatches.map(c => c.id)
             ]);

             if (allIds.size === 0 && s.isManaged) {
                 const normalizedService = normalizeNameToken(s.name);
                 if (normalizedService) {
                     targetContainers.forEach(container => {
                         const tokens = getContainerTokens(container);
                         const matchesToken = tokens.some(token => token === normalizedService || token.startsWith(`${normalizedService}-`));
                         if (matchesToken) {
                             allIds.add(container.id);
                         }
                     });
                 }
             }
             
             s.associatedContainerIds = Array.from(allIds);
        });
    }
    
    // APPLY UPDATE TO STORE
    this.nodes[nodeId] = {
        ...this.nodes[nodeId],
        ...data,
        lastSync: Date.now()
    };

    // Re-attach health from the side map. The agent's sync replaces
    // `services` wholesale, so without this the health field gets
    // wiped between probe runs. See `serviceHealth` definition.
    this.applyServiceHealthToNode(nodeId);

    // ENRICHMENT: Calculate Derived Properties (Effective Ports, Host Network)
    // This makes the Twin the Single Source of Truth for "Service Properties"
    this.enrichNode(nodeId, this.nodes[nodeId]);
    this.scheduleBundleRebuild(nodeId);

    // AGGREGATION: Update Global Proxy State
    this.recalculateGlobalProxy();

    // Debug logging for updates
    // if (Object.keys(data).length > 0) {
    //    logger.info('TwinStore', `Updated ${nodeId} | Keys: ${Object.keys(data).join(', ')} | Instance: ${this.instanceId}`);
    // }

    this.notifyListeners();
  }

    // #1036: Coalesce a burst of agent updates into a single bundle
    // rebuild. Resetting the timer pushes the deadline. rebuildBundlesNow
    // is also exposed for explicit operator-triggered fetches.
    private scheduleBundleRebuild(nodeId: string): void {
        const existing = this.bundleRebuildTimers.get(nodeId);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            this.bundleRebuildTimers.delete(nodeId);
            this.rebuildBundlesNow(nodeId);
        }, this.bundleRebuildDebounceMs);
        if (typeof t === 'object' && t && 'unref' in t && typeof t.unref === 'function') t.unref();
        this.bundleRebuildTimers.set(nodeId, t);
    }

    public rebuildBundlesNow(nodeId: string): void {
        const node = this.nodes[nodeId];
        if (!node) return;
        const built = buildServiceBundlesForNode({ nodeName: nodeId, services: node.services, containers: node.containers, files: node.files });
        const dismissed = new Set(node.dismissedBundles || []);
        node.unmanagedBundles = dismissed.size > 0 ? built.filter(b => !dismissed.has(b.id)) : built;
        this.notifyListeners();
    }

    public dismissUnmanagedBundle(nodeId: string, bundleId: string): boolean {
            if (!bundleId) return false;
            const node = this.nodes[nodeId];
            if (!node) return false;

            if (!node.dismissedBundles.includes(bundleId)) {
                    node.dismissedBundles.push(bundleId);
            }

            const previousLength = node.unmanagedBundles.length;
            node.unmanagedBundles = node.unmanagedBundles.filter(bundle => bundle.id !== bundleId);

            const didRemove = node.unmanagedBundles.length !== previousLength;
            this.notifyListeners();
            return didRemove;
    }

  private recalculateGlobalProxy() {
      const allRoutes: ProxyRoute[] = [];
      const seen = new Set<string>();

      // Aggregate routes from all connected nodes
      Object.values(this.nodes).forEach(node => {
          if (node.connected && node.proxyRoutes && node.proxyRoutes.length > 0) {
              node.proxyRoutes.forEach(route => {
                  // Unique key based on host
                  const key = route.host;
                  if (!seen.has(key)) {
                      seen.add(key);
                      allRoutes.push(route);
                  }
              });
          }
      });

      this.proxyState.routes = allRoutes;
      
      // REVERSE MAPPING: Enrich Services/Containers with Verified Domains
      this.mapDomainsToServices();
  }

  private mapDomainsToServices() {
      // Create a lookup map for Global Routes
      // Target (IP:Port or ServiceName:Port) -> Domain[]
      const targetMap = new Map<string, string[]>();
      
      this.proxyState.routes.forEach(r => {
          // Normalize Target
          // r.targetService can be: "192.168.1.100:8080", "nginx:80", "http://container:3000"
          let target = r.targetService.replace(/^https?:\/\//, '');
          // Strip trailing slash
          if (target.endsWith('/')) target = target.slice(0, -1);
          
          if (!targetMap.has(target)) {
              targetMap.set(target, []);
          }
          targetMap.get(target)!.push(r.host);
      });

      // Iterate all Nodes -> Services/Containers to match targets
      Object.values(this.nodes).forEach((node) => {
          const nodeIPs = new Set<string>();
          // Try to get Node IPs
          if (node.resources?.network) {
               Object.values(node.resources.network).flat().forEach(net => {
                   if (net.family === 'IPv4' && !net.internal) nodeIPs.add(net.address);
               });
          }
          // Also check explicit metadata passed via gateway config or manual settings? 
          // For now, rely on resources.network or loopback if router is local.
          
          // Container Helper
          const enrichEntity = (entity: EnrichedContainer | ServiceUnit) => {
               // Must have ports to be reachable
               if (!entity.ports || entity.ports.length === 0) return;
               
               const matchedDomains = new Set<string>();
               
               entity.ports.forEach(p => {
                    const hostPort = p.hostPort;
                    if (!hostPort) return;
                    
                    // Possible targets for this service:
                    // 1. Unqualified: "containerName:Port" (Only if docker network) - Hard to match here without network context.
                    // 2. Localhost: "127.0.0.1:Port" (If proxy is on SAME node)
                    // 3. NodeIP: "192.168.x.x:Port" (If proxy is EXTERNAL or using host binding)
                    
                    const targetsToCheck = [
                        `127.0.0.1:${hostPort}`,
                        `localhost:${hostPort}`,
                        `0.0.0.0:${hostPort}`
                    ];
                    
                    if (nodeIPs.size > 0) {
                        nodeIPs.forEach(ip => targetsToCheck.push(`${ip}:${hostPort}`));
                    }
                    
                    targetsToCheck.forEach(t => {
                        if (targetMap.has(t)) {
                            targetMap.get(t)!.forEach(d => matchedDomains.add(d));
                        }
                    });
               });
               
               if (matchedDomains.size > 0) {
                   entity.verifiedDomains = Array.from(matchedDomains);
               } else {
                   delete entity.verifiedDomains;
               }
          };

          if (node.services) node.services.forEach(enrichEntity);
          if (node.containers) node.containers.forEach(enrichEntity);
      });
  }

    private static readonly KNOWN_PROXY_KEYWORDS = ['nginx', 'nginx', 'haproxy', 'traefik', 'caddy', 'envoy'];
    private static readonly PROXY_EXCLUDE_KEYWORDS = ['mpris-proxy'];
    private static readonly SERVICEBAY_KEYWORDS = ['servicebay', 'service-bay', 'service_bay'];

    private isReverseProxyService(service: ServiceUnit, containers: EnrichedContainer[]): boolean {
          const nameCandidates = this.buildServiceNameCandidates(service);
          const descriptionCandidate = service.description?.toLowerCase();

          if (this.isProxyNameMatch(nameCandidates) || this.isProxyName(descriptionCandidate)) {
              return true;
          }

          const linkedContainers = this.resolveLinkedContainers(service, containers, nameCandidates);

          if (linkedContainers.some(c => c.labels?.['servicebay.role'] === 'reverse-proxy')) {
              return true;
          }

          if (linkedContainers.some(c => this.isProxyName(c.image?.toLowerCase()))) {
              return true;
          }

          if (linkedContainers.some(c => (c.names || []).some(name => this.isProxyName(name.replace(/^\//, '').toLowerCase())))) {
              return true;
          }

          return false;
      }

    private isServiceBayService(service: ServiceUnit, containers: EnrichedContainer[]): boolean {
          const nameCandidates = this.buildServiceNameCandidates(service);

          if (this.hasServiceBayKeyword(nameCandidates)) {
              return true;
          }
          if (this.matchesServiceBayKeyword(service.description) || this.matchesServiceBayKeyword(service.path) || this.matchesServiceBayKeyword(service.fragmentPath)) {
              return true;
          }

          const linkedContainers = this.resolveLinkedContainers(service, containers, nameCandidates);

          if (linkedContainers.some(c => this.containerHasServiceBayLabel(c))) {
              return true;
          }
          if (linkedContainers.some(c => this.matchesServiceBayKeyword(c.image))) {
              return true;
          }
          if (linkedContainers.some(c => (c.names || []).some(name => this.matchesServiceBayKeyword(name)))) {
              return true;
          }

          return false;
      }

    private isProxyName(value?: string): boolean {
          if (!value) return false;
          const normalized = value.toLowerCase();
          if (DigitalTwinStore.PROXY_EXCLUDE_KEYWORDS.some(ex => normalized.includes(ex))) {
              return false;
          }
          if (DigitalTwinStore.KNOWN_PROXY_KEYWORDS.some(keyword => normalized.includes(keyword))) {
              return true;
          }
          return normalized.includes('proxy');
      }

    private isProxyNameMatch(candidates: Set<string>): boolean {
          for (const name of candidates) {
              if (this.isProxyName(name)) {
                  return true;
              }
          }
          return false;
      }

    private buildServiceNameCandidates(service: ServiceUnit): Set<string> {
          const candidates = new Set<string>();
          if (service.name) {
              candidates.add(service.name.toLowerCase());
              if (service.name.endsWith('.service')) {
                  candidates.add(service.name.replace(/\.service$/, '').toLowerCase());
              }
          }
          return candidates;
      }

    private resolveLinkedContainers(service: ServiceUnit, containers: EnrichedContainer[], nameCandidates: Set<string>): EnrichedContainer[] {
          const normalizedCandidates = Array.from(nameCandidates);
          return containers.filter(c => {
              if (service.associatedContainerIds?.includes(c.id)) return true;
              const normalizedNames = (c.names || []).map(n => n.replace(/^\//, '').toLowerCase());
              return normalizedCandidates.some(candidate =>
                  normalizedNames.includes(candidate) || normalizedNames.includes(`systemd-${candidate}`)
              );
          });
      }

    private matchesServiceBayKeyword(value?: string): boolean {
          if (!value) return false;
          const normalized = value.toLowerCase();
          return DigitalTwinStore.SERVICEBAY_KEYWORDS.some(keyword => normalized.includes(keyword));
      }

    private hasServiceBayKeyword(candidates: Set<string>): boolean {
          for (const value of candidates) {
              if (this.matchesServiceBayKeyword(value)) {
                  return true;
              }
          }
          return false;
      }

    private containerHasServiceBayLabel(container: EnrichedContainer): boolean {
          const role = container.labels?.['servicebay.role'];
          const protectedLabel = container.labels?.['servicebay.protected'];
          return role === 'system' || protectedLabel === 'true';
      }

  private enrichNode(nodeId: string, node: NodeTwin) {
      const nodeIPs = this.collectNodeIPv4Addresses(node);
      node.nodeIPs = nodeIPs;

      if (node.containers && node.containers.length > 0) {
          node.containers.forEach(container => {
              if (container.ports && container.ports.length > 0) {
                  container.ports = container.ports.map(port => ({
                      ...port,
                      hostIp: this.resolveHostIpForPort(port.hostIp, nodeIPs)
                  }));
              }
          });
      }

      if (!node.services || !node.containers) return;

      // 1. Build Metrics for Dynamic Port Lookup
      const pidToPorts = new Map<number, PortMapping[]>();
      node.containers.forEach(c => {
          if (c.state === 'running' && c.pid && c.ports && c.ports.length > 0) {
              pidToPorts.set(c.pid, c.ports);
          }
      });
      const containerMap = new Map<string, EnrichedContainer>();
      node.containers.forEach(c => containerMap.set(c.id, c));

      // 2. Iterate Services to Calculate Effective State
      node.services.forEach(svc => {
          const linkedIds = svc.associatedContainerIds || [];
          const linkedContainers = linkedIds.map(id => containerMap.get(id)).filter((c): c is EnrichedContainer => !!c);

          // Initialize Dynamic Ports (Will be populated by Proxy Logic and Container/PID Logic)
          const dynamicPorts: PortMapping[] = [];

          // A. Effective Host Network
          // If ANY linked container is host network, the service is effectively host network
          const isContainerHostNetwork = linkedContainers.some(c => c.isHostNetwork || c.networks?.includes('host'));
          svc.effectiveHostNetwork = isContainerHostNetwork; // Note: Service unit file might not say it, but runtime does.

          // C. Proxy-Specific Enrichment (Source of Truth for Nginx Ports)
          if (svc.isPrimaryProxy && node.proxyRoutes && node.proxyRoutes.length > 0) {
              const standardPorts = new Set<number>();
              
              // 1. Gather configured routes
              node.proxyRoutes.forEach(r => {
                  standardPorts.add(80); // Always listen on 80
                  if (r.ssl) standardPorts.add(443);
              });

              // 2. Map to PortMapping structure
              const derivedPorts: PortMapping[] = Array.from(standardPorts).map(p => ({
                  hostPort: p,
                  containerPort: p, // Nginx usually maps 80:80, 443:443 on host network
                  protocol: 'tcp', 
                  hostIp: '0.0.0.0'
              }));
              
              // 3. MERGE with Runtime Ports
              // Add assumed standard ports (80/443) to dynamicPorts. 
              // Later logic (Deduplication) will prevent duplicates if the runtime also finds them.
              derivedPorts.forEach(dp => {
                  // We push directly here, assuming dynamicPorts is empty or we don't care about internal dupes yet.
                  // (Real deduplication happens when merging other sources or at the end if needed)
                  dynamicPorts.push(dp);
              });
              
              // Enrich with Proxy Configuration (Nginx Routes)
              if (node.proxyRoutes) {
                  svc.proxyConfiguration = {
                      servers: node.proxyRoutes.map((r) => {
                           let targetService = typeof r.targetService === 'string' && r.targetService.startsWith('http') 
                            ? r.targetService 
                            : `http://${r.targetService}`;
                          
                          // Ensure port is in the URL if provided
                          if (r.targetPort && !targetService.includes(`:${r.targetPort}`)) {
                               // Be careful not to double add if it's implicit 80/443, 
                               // but strictly `proxy_pass` needs port.
                               // Check if targetService already has A port
                               // Regex: colon followed by digits at end or before /
                               if (!/:\d+(\/|$)/.test(targetService)) {
                                   // No port found, append it
                                   targetService = `${targetService}:${r.targetPort}`;
                               }
                          }

                          // Clean Protocol for raw storage
                          const rawHost = r.targetService.replace(/^https?:\/\//, '').split(':')[0];

                          return {
                            server_name: [r.host],
                            listen: r.ssl ? ['443 ssl', '80'] : ['80'],
                            locations: [{
                                path: '/',
                                proxy_pass: targetService
                            }],
                            // Metadata
                            _agent_data: true, // Marker for Frontend
                            _ssl: r.ssl,
                            _targetPort: r.targetPort || 80,
                            // CRITICAL FIX: Pass through the raw target host/port for Graph logic!
                            variable_fields: {
                                targetHost: rawHost, // Clean Host/IP only
                                targetPort: r.targetPort || 80 // Explicit or default
                            }
                        };
                      })
                  };
              }
              
              // DO NOT RETURN EARLY! 
              // Instead, initialize 'dynamicPorts' with our derived ones, and let the rest of the logic
              // merge in the actual container ports (which will catch 81, etc.)
              // dynamicPorts = derivedPorts; (Wait, we need to convert format matching below)
              // Actually, simply pushing them to dynamicPorts is enough if we trust our deduplication logic below.
              
              // Actually dynamicPorts are 'discovered' ports. derivedPorts are 'assumed' ports.
              // We can just add them to the svc.ports at the end.
              
              // Let's seed the discovered ports with the assumed ones, so at least 80/443 show up even if agent fails.
              // But if agent succeeds (which it should now), it will find 80/443/81.
              // So maybe we don't need derivedPorts AT ALL if discovery works?
              // YES. If discovery works, we should trust it. The 'derivedPorts' was a fallback.
              // But 'isPrimaryProxy' logic was overriding everything.
              
              // FIX: Remove 'return;' to allow runtime discovery to augment/replace these defaults.
              // We'll add derivedPorts ONLY if they aren't found by discovery.
          }

          // B. Effective Ports (Consolidated into 'ports')
          // Priority 1: Dynamic Ports from PID (if running & host network)
          // let dynamicPorts: PortMapping[] = []; // MOVED UP
          
          // ALWAYS TRY TO ENRICH PORTS FROM LINKED CONTAINERS
          // Whether it is host network or not, if the container has ports, the service should have them.
          // The previous condition (svc.effectiveHostNetwork || linkedContainers.some(c => c.ports.length == 0)) was too restrictive.
          
          // Helper for robust key access (camelCase vs snake_case)
          const getHP = (p: PortMapping) => p.hostPort;
          const getCP = (p: PortMapping) => p.containerPort;

          // Case 1: Dynamic PID Ports (Host Network/Socket Activation)
          if (svc.active && (svc.effectiveHostNetwork || linkedContainers.some(c => c.ports && c.ports.length === 0))) {
              linkedContainers.forEach(c => {
                   if (c.pid && pidToPorts.has(c.pid)) {
                       const ports = pidToPorts.get(c.pid)!;
                       // Deduplicate
                       ports.forEach(p => {
                           // Loose matching on port numbers using robust helpers
                           if (!dynamicPorts.some(dp => getHP(dp) === getHP(p) && getCP(dp) === getCP(p) && dp.protocol === p.protocol)) {
                               dynamicPorts.push(p);
                           }
                       });
        
                   }
              });
          }
          
          // Case 2: Static Container Ports (Bridge Mode / Port Mappings)
          // Even if not host network, we want to aggregate all ports from all containers in this pod/service.
          linkedContainers.forEach(c => {
               if (c.ports) {
                   c.ports.forEach(p => {
                       // Deduplicate against dynamic ports AND existing list
                       if (!dynamicPorts.some(dp => getHP(dp) === getHP(p) && getCP(dp) === getCP(p))) {
                           dynamicPorts.push(p);
                       }
                   });
               }
          });

          // Always extract YAML-defined ports as the baseline source of truth
          const yamlPorts = this.extractStaticPortsForService(svc, node, nodeIPs);

          // Merge: start with YAML-defined ports, then add any runtime-discovered ports not already present
          const mergedPorts = [...yamlPorts];
          dynamicPorts.forEach(dp => {
              const resolved = { ...dp, hostIp: this.resolveHostIpForPort(dp.hostIp, nodeIPs) };
              const alreadyPresent = mergedPorts.some(mp =>
                  getHP(mp) === getHP(resolved) && getCP(mp) === getCP(resolved) && mp.protocol === resolved.protocol
              );
              if (!alreadyPresent) {
                  mergedPorts.push(resolved);
              }
          });

          if (mergedPorts.length > 0) {
              svc.ports = mergedPorts;
          }
      });
  }

  private collectNodeIPv4Addresses(node: NodeTwin): string[] {
      if (!node.resources?.network) return [];
      const seen = new Set<string>();
      Object.values(node.resources.network).forEach(entries => {
          entries.forEach(entry => {
              if (entry.family === 'IPv4' && !entry.internal && entry.address) {
                  seen.add(entry.address);
              }
          });
      });
      return Array.from(seen);
  }

  private resolveHostIpForPort(currentHostIp: string | undefined, nodeIPs: string[]): string | undefined {
      if (currentHostIp && !this.isWildcardHostIp(currentHostIp)) {
          return currentHostIp;
      }
      return nodeIPs[0] || currentHostIp || undefined;
  }

  private isWildcardHostIp(value?: string): boolean {
      if (!value) return true;
      const normalized = value.trim();
      return normalized === '' || normalized === '0.0.0.0' || normalized === '::' || normalized === '::0' || normalized === '*';
  }

  private extractStaticPortsForService(service: ServiceUnit, node: NodeTwin, nodeIPs: string[]): PortMapping[] {
      if (!node.files) return [];
      const baseName = service.name?.replace(/\.service$/, '') || service.name;
      if (!baseName) return [];

      // Check cache: skip re-parsing if the underlying file content hasn't changed
      const kubeEntry = this.findFileBySuffix(node.files, `/${baseName}.kube`);
      const containerEntry = this.findFileBySuffix(node.files, `/${baseName}.container`);
      const contentKey = (kubeEntry?.[1]?.content || '') + '|' + (containerEntry?.[1]?.content || '');
      const cached = this.staticPortsCache.get(baseName);
      if (cached && cached.contentKey === contentKey) {
          return cached.ports;
      }

      const ports = this.collectStaticPortsFromUnitFiles(kubeEntry, containerEntry, node.files, service.name, nodeIPs);
      this.staticPortsCache.set(baseName, { contentKey, ports });
      return ports;
  }

  /**
   * Parse the `.kube`/`.container` unit files into a port list. Split out
   * of `extractStaticPortsForService` so that method stays a thin
   * guard + cache + delegate (its complexity was over budget); the
   * file-format branches live here. Kube ports take precedence: if the
   * kube YAML yields any port the container file is not consulted.
   */
  private collectStaticPortsFromUnitFiles(
      kubeEntry: [string, WatchedFile] | undefined,
      containerEntry: [string, WatchedFile] | undefined,
      files: Record<string, WatchedFile>,
      serviceName: string | undefined,
      nodeIPs: string[],
  ): PortMapping[] {
      const ports: PortMapping[] = [];
      const pushPort = (hostPort?: number, containerPort?: number, protocol?: string, hostIp?: string) => {
          const normalizedContainer = containerPort ?? hostPort;
          if (!normalizedContainer) return;
          const resolvedHost = hostPort ?? normalizedContainer;
          ports.push({
              hostPort: resolvedHost,
              containerPort: normalizedContainer,
              protocol: (protocol || 'tcp').toLowerCase(),
              hostIp: this.resolveHostIpForPort(hostIp, nodeIPs)
          });
      };

      if (kubeEntry) {
          const [kubePath, kubeFile] = kubeEntry;
          const match = kubeFile.content?.match(/^Yaml=(.+)$/m);
          if (match) {
              const yamlContent = this.getYamlContent(files, kubePath, match[1].trim());
              if (yamlContent) extractPortsFromKubeYaml(yamlContent, serviceName, pushPort);
          }
          if (ports.length > 0) return ports;
      }

      if (containerEntry) {
          const [, containerFile] = containerEntry;
          if (containerFile.content) {
              extractPortsFromQuadletContainer(containerFile.content, pushPort);
          }
      }

      return ports;
  }

  private findFileBySuffix(files: Record<string, WatchedFile>, suffix: string): [string, WatchedFile] | undefined {
      const key = Object.keys(files).find((filePath) => filePath.endsWith(suffix));
      return key ? [key, files[key]] : undefined;
  }

  private getYamlContent(files: Record<string, WatchedFile>, basePath: string, relative: string): string | null {
      const directPath = path.join(path.dirname(basePath), relative);
      if (files[directPath]?.content) {
          return files[directPath].content;
      }
      const fallbackKey = Object.keys(files).find((filePath) => filePath.endsWith(`/${relative}`));
      return fallbackKey ? files[fallbackKey].content : null;
  }

  public recordMigrationEvent(nodeId: string, event: MigrationHistoryEntry) {
      this.registerNode(nodeId);
      const node = this.nodes[nodeId];
      const nextHistory = [event, ...(node.history || [])].slice(0, DigitalTwinStore.HISTORY_LIMIT);
      node.history = nextHistory;
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

  /**
   * Upsert a single service's health-probe result (#626). Stored in the
   * side-map AND mirrored onto the current `services[].health` so
   * readers don't have to know about the two-store split. `updateNode`
   * re-attaches from the side-map on every agent sync so the field
   * survives the periodic services-array replacement.
   */
  public setServiceHealth(nodeId: string, serviceName: string, health: ServiceHealth): void {
    if (!this.serviceHealth[nodeId]) this.serviceHealth[nodeId] = {};
    this.serviceHealth[nodeId][serviceName] = health;
    const node = this.nodes[nodeId];
    if (node) {
      const svc = node.services?.find(s => s.name === serviceName);
      if (svc) svc.health = health;
    }
    this.notifyListeners();
  }

  /** Drop a service's recorded health — used when the service is wiped
   *  or its template loses the healthcheck annotation. */
  public clearServiceHealth(nodeId: string, serviceName: string): void {
    if (this.serviceHealth[nodeId]) {
      delete this.serviceHealth[nodeId][serviceName];
    }
    const node = this.nodes[nodeId];
    if (node) {
      const svc = node.services?.find(s => s.name === serviceName);
      if (svc) delete svc.health;
    }
    this.notifyListeners();
  }

  /** Internal: re-attach side-map health onto `services[].health` after
   *  an agent sync replaces the services array. Called from `updateNode`
   *  unconditionally — cheap when the side-map is empty. */
  private applyServiceHealthToNode(nodeId: string): void {
    const map = this.serviceHealth[nodeId];
    if (!map) return;
    const node = this.nodes[nodeId];
    if (!node?.services) return;
    for (const svc of node.services) {
      const h = map[svc.name];
      if (h) svc.health = h;
    }
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
  
  public serverName: string | null = null;

  public setServerName(name: string | null) {
      this.serverName = name || null;
      this.notifyListeners();
  }

  public getSnapshot() {
      return {
          instanceId: this.instanceId,
          serverName: this.serverName,
          nodes: this.nodes,
          gateway: this.gateway,
          proxyState: this.proxyState
      }
  }
}

// Helper: Ensure ports are strictly PortMapping objects
function normalizePort(port: unknown): PortMapping {
    if (typeof port === 'number') {
        return { hostPort: port, containerPort: port, protocol: 'tcp' };
    }
    if (typeof port === 'string') {
        // Handle "8080/tcp" or "80:80" common formats just in case
        const p = parseInt(port as string, 10);
        if (!isNaN(p)) return { hostPort: p, containerPort: p, protocol: 'tcp' };
    }
    if (typeof port === 'object' && port !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = port as any;
        return {
            hostPort: p.hostPort || p.host || p.host_port,
            containerPort: p.containerPort || p.container || p.container_port,
            protocol: p.protocol || 'tcp',
            hostIp: p.hostIp || p.host_ip || p.IP
        };
    }
    // Fallback
    return { protocol: 'tcp' };
}
