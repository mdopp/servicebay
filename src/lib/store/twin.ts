import path from 'path';
import yaml from 'js-yaml';
import { EnrichedContainer, ServiceUnit, SystemResources, Volume, WatchedFile, ProxyRoute, PortMapping } from '../agent/types';
import { logger } from '../logger';
import type { AgentHealth } from '../agent/handler';

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
  health?: AgentHealth;
    nodeIPs: string[];
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
                proxy: [],
                nodeIPs: []
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
        logger.error('TwinStore', `Invalid containers update for ${nodeId} (expected Array):`, typeof data.containers);
        delete data.containers;
    }
    if (data.services !== undefined && !Array.isArray(data.services)) {
        logger.error('TwinStore', `Invalid services update for ${nodeId} (expected Array):`, typeof data.services);
        delete data.services;
    }
    if (data.volumes !== undefined && !Array.isArray(data.volumes)) {
        logger.error('TwinStore', `Invalid volumes update for ${nodeId} (expected Array):`, typeof data.volumes);
        delete data.volumes;
    }
    if (data.proxy !== undefined && !Array.isArray(data.proxy)) {
         logger.error('TwinStore', `Invalid proxy update for ${nodeId} (expected Array):`, typeof data.proxy);
         delete data.proxy;
    }

    // Files is a Record (Object)
    if (data.files !== undefined && (typeof data.files !== 'object' || data.files === null || Array.isArray(data.files))) {
         logger.error('TwinStore', `Invalid files update for ${nodeId} (expected Object):`, typeof data.files);
         delete data.files;
    }

    // Normalization: Ensure ports are PortMapping objects
    if (data.containers) {
          data.containers.forEach(c => {
              if (c.ports && Array.isArray(c.ports)) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  c.ports = c.ports.map((p: any) => normalizePort(p));
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
                 const standards = ['nginx', 'nginx-web', 'traefik', 'caddy'];
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
             
             s.associatedContainerIds = Array.from(allIds);
        });
    }
    
    // APPLY UPDATE TO STORE
    this.nodes[nodeId] = {
        ...this.nodes[nodeId],
        ...data,
        lastSync: Date.now()
    };

    // ENRICHMENT: Calculate Derived Properties (Effective Ports, Host Network)
    // This makes the Twin the Single Source of Truth for "Service Properties"
    this.enrichNode(nodeId, this.nodes[nodeId]);

    // AGGREGATION: Update Global Proxy State
    this.recalculateGlobalProxy();

    // Debug logging for updates
    // if (Object.keys(data).length > 0) {
    //    logger.info('TwinStore', `Updated ${nodeId} | Keys: ${Object.keys(data).join(', ')} | Instance: ${this.instanceId}`);
    // }

    this.notifyListeners();
  }

  private recalculateGlobalProxy() {
      const allRoutes: ProxyRoute[] = [];
      const seen = new Set<string>();

      // Aggregate routes from all connected nodes
      Object.values(this.nodes).forEach(node => {
          if (node.connected && node.proxy && node.proxy.length > 0) {
              node.proxy.forEach(route => {
                  // Unique key based on host
                  const key = route.host;
                  if (!seen.has(key)) {
                      seen.add(key);
                      allRoutes.push(route);
                  }
              });
          }
      });

      this.proxy.routes = allRoutes;
      
      // REVERSE MAPPING: Enrich Services/Containers with Verified Domains
      this.mapDomainsToServices();
  }

  private mapDomainsToServices() {
      // Create a lookup map for Global Routes
      // Target (IP:Port or ServiceName:Port) -> Domain[]
      const targetMap = new Map<string, string[]>();
      
      this.proxy.routes.forEach(r => {
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

    private static readonly KNOWN_PROXY_KEYWORDS = ['nginx', 'nginx-web', 'haproxy', 'traefik', 'caddy', 'envoy'];
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
          if (svc.isPrimaryProxy && node.proxy && node.proxy.length > 0) {
              const standardPorts = new Set<number>();
              
              // 1. Gather configured routes
              node.proxy.forEach(r => {
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
              if (node.proxy) {
                  svc.proxyConfiguration = {
                      servers: node.proxy.map((r) => {
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

          if (dynamicPorts.length > 0) {
              const resolvedPorts = dynamicPorts.map(port => ({
                  ...port,
                  hostIp: this.resolveHostIpForPort(port.hostIp, nodeIPs)
              }));
              svc.ports = resolvedPorts;
              // logger.debug('TwinStore', `Enriched ${svc.name} with dynamic ports: ${dynamicPorts.length}`);
          } else if (!svc.ports || svc.ports.length === 0) {
              const staticPorts = this.extractStaticPortsForService(svc, node, nodeIPs);
              if (staticPorts.length > 0) {
                  svc.ports = staticPorts;
              }
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

      const files = node.files;
      const kubeEntry = this.findFileBySuffix(files, `/${baseName}.kube`);
      if (kubeEntry) {
          const [kubePath, kubeFile] = kubeEntry;
          if (kubeFile.content) {
              const match = kubeFile.content.match(/^Yaml=(.+)$/m);
              if (match) {
                  const yamlRef = match[1].trim();
                  const yamlContent = this.getYamlContent(files, kubePath, yamlRef);
                  if (yamlContent) {
                      try {
                          const docs = yaml.loadAll(yamlContent) as unknown[];
                          docs.forEach(doc => {
                              if (!doc || typeof doc !== 'object') return;
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              const spec = (doc as any).spec;
                              if (!spec) return;
                              const hostNetwork = Boolean(spec.hostNetwork);
                              const containers = Array.isArray(spec.containers) ? spec.containers : [];
                              containers.forEach((containerDoc: unknown) => {
                                  if (!containerDoc || typeof containerDoc !== 'object') return;
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                  const portsDef = Array.isArray((containerDoc as any).ports) ? (containerDoc as any).ports : [];
                                  portsDef.forEach((portDef: unknown) => {
                                      if (!portDef || typeof portDef !== 'object') return;
                                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                      const descriptor = portDef as any;
                                      const containerPort = this.safeParsePort(descriptor.containerPort ?? descriptor.container_port ?? descriptor.port);
                                      if (!containerPort) return;
                                      let hostPort = this.safeParsePort(descriptor.hostPort ?? descriptor.host_port);
                                      if (!hostPort && hostNetwork) hostPort = containerPort;
                                      pushPort(hostPort, containerPort, descriptor.protocol);
                                  });
                              });
                          });
                      } catch (err) {
                          logger.warn('TwinStore', `Failed to parse YAML for ${service.name}`, err);
                      }
                  }
              }
          }
          if (ports.length > 0) {
              return ports;
          }
      }

      const containerEntry = this.findFileBySuffix(files, `/${baseName}.container`);
      if (containerEntry) {
          const [, containerFile] = containerEntry;
          if (containerFile.content) {
              let hostNetwork = false;
              const lines = containerFile.content.split('\n');
              for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.length === 0) continue;
                  if (trimmed.startsWith('Network=')) {
                      hostNetwork = trimmed.split('=')[1]?.trim() === 'host';
                      continue;
                  }
                  if (trimmed.startsWith('PublishPort=')) {
                      const definition = trimmed.substring('PublishPort='.length);
                      const [portPart, protoPart] = definition.split('/');
                      const segments = portPart.split(':').filter(Boolean);
                      let ip: string | undefined;
                      let hostStr: string | undefined;
                      let containerStr: string | undefined;

                      if (segments.length === 3) {
                          [ip, hostStr, containerStr] = segments;
                      } else if (segments.length === 2) {
                          [hostStr, containerStr] = segments;
                      } else if (segments.length === 1) {
                          hostStr = segments[0];
                          containerStr = segments[0];
                      }

                      const containerPort = this.safeParsePort(containerStr);
                      let hostPort = this.safeParsePort(hostStr);
                      if (!hostPort && hostNetwork && containerPort) {
                          hostPort = containerPort;
                      }

                      if (containerPort || hostPort) {
                          pushPort(hostPort, containerPort ?? hostPort, protoPart, ip);
                      }
                  }
              }
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

  private safeParsePort(value: unknown): number | undefined {
      if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
      }
      if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed)) {
              return parsed;
          }
      }
      return undefined;
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
          instanceId: this.instanceId,
          nodes: this.nodes,
          gateway: this.gateway,
          proxy: this.proxy
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
