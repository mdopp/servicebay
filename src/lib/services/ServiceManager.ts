import { agentManager } from '../agent/manager';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../logger';
import { getConfig } from '../config';
import { saveSnapshot } from '../history';
import { injectServiceDirectives } from './quadletDirectives';

const SYSTEMD_DIR = '.config/containers/systemd';

/** Extract string content from agent read_file response ({content: string} or string) */
function extractFileContent(res: unknown): string {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'content' in res && typeof (res as { content: unknown }).content === 'string') {
        return (res as { content: string }).content;
    }
    return '';
}

export interface ServiceInfo {
  name: string;
  kubeFile: string;
  kubePath: string;
  yamlFile: string | null;
  yamlPath: string | null;
  active: boolean;
  status: string;
  description?: string;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  labels: Record<string, string>;
  hostNetwork?: boolean;
  node?: string;
  id?: string;
  isReverseProxy?: boolean;
  isServiceBay?: boolean;
  verifiedDomains?: string[];
}

export class ServiceManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static fileParseCache = new Map<string, { hash: string, parsed: any[] }>();

    static async listServices(nodeName: string): Promise<ServiceInfo[]> {
        // V4: Use DigitalTwinStore
        const { DigitalTwinStore } = await import('../store/twin');
        const twin = DigitalTwinStore.getInstance().nodes[nodeName];
        const proxyState = DigitalTwinStore.getInstance().proxy; // Access Global Proxy State

        if (!twin) return [];

        const services: ServiceInfo[] = [];

        for (const [filePath, file] of Object.entries(twin.files)) {
            // Only process .kube and .container
            if (!filePath.endsWith('.kube') && !filePath.endsWith('.container')) continue;
            
            const fileName = path.basename(filePath);
            const baseName = filePath.endsWith('.kube') ? fileName.replace('.kube', '') : fileName.replace('.container', '');
            const type = filePath.endsWith('.kube') ? 'kube' : 'container';

            // Find State
            const unitName = `${baseName}.service`;
            // Relaxed matching for service unit (strip .service to compare with baseName)
            const serviceUnit = twin.services.find(s => s.name === unitName || s.name === baseName);
            
            // STRICT MATCHING Strategy (RFC-Compliant):
            // 1. Service Name is the Single Source of Truth.
            // 2. Containers MUST adhere to systemd-generated naming conventions:
            //    - "systemd-<serviceName>" (e.g., systemd-adguard)
            //    - "<serviceName>-<serviceName>" (e.g., adguard-adguard, typical for Pods)
            //    - Exact match (legacy/simple)
            
            // NEW STRATEGY: Parse YAML first if available to get explicit container names
            const expectedNames = [
                baseName,                   // simple
                `systemd-${baseName}`,      // quadlet root
                `${baseName}-${baseName}`   // pod member
            ];
            
            // Attempt to read YAML *before* container matching to extract explicit names
            let yamlContent: string | null = null;
            let yamlPath: string | null = null;
            let yamlFile: string | null = null;

            if (type === 'kube' && file.content) {
                 const match = file.content.match(/^Yaml=(.+)$/m);
                 if (match) {
                     yamlFile = match[1].trim();
                     yamlPath = path.join(path.dirname(filePath), yamlFile);
                     
                     // Find YAML content
                     yamlContent = twin.files[yamlPath]?.content;
                     if (!yamlContent) {
                         const foundPath = Object.keys(twin.files).find(p => p.endsWith(yamlFile!));
                         if (foundPath) yamlContent = twin.files[foundPath].content;
                     }

                     if (yamlContent) {
                         try {
                             // Use Cache if content matches
                             const cacheKey = `${nodeName}:${yamlPath}`;
                             const cached = ServiceManager.fileParseCache.get(cacheKey);
                             // eslint-disable-next-line @typescript-eslint/no-explicit-any
                             let docs: any[] = [];

                             if (cached && cached.hash === yamlContent) {
                                 // Cache Hit
                                 docs = cached.parsed;
                             } else {
                                 // Cache Miss or Stale
                                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                 docs = yaml.loadAll(yamlContent) as any[];
                                 ServiceManager.fileParseCache.set(cacheKey, { hash: yamlContent, parsed: docs });
                             }

                             docs.forEach(doc => {
                                 // Add PodName explicitly if defined
                                 if (doc?.metadata?.name) {
                                     expectedNames.push(`${doc.metadata.name}`); // Entire Pod might share name? 
                                 }
                                 
                                 if (doc?.spec?.containers) {
                                     // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                     doc.spec.containers.forEach((c: any) => {
                                         if (c.name) {
                                             // Podman usually namespaces usage: PodName-ContainerName
                                             // or ServiceName-ContainerName
                                             
                                             // Add raw container name (unlikely alone in a pod, but possible)
                                             expectedNames.push(c.name);
                                             
                                             // Add ServiceName-ContainerName
                                             expectedNames.push(`${baseName}-${c.name}`);
                                             
                                             // Add PodName-ContainerName (if pod name known)
                                             if (doc.metadata?.name) {
                                                  expectedNames.push(`${doc.metadata.name}-${c.name}`);
                                             }
                                         }
                                     });
                                 }
                             });
                         } catch { /* ignore parse error here, handled below */ }
                     }
                 }
            }
            
            // Deduplicate names
            const uniqueExpected = Array.from(new Set(expectedNames));

            const candidates = twin.containers.filter(c => {
                 if (!c.names) return false;
                 return c.names.some(n => {
                     const cleanName = n.replace(/^\//, ''); // Strip leading slash
                     return uniqueExpected.includes(cleanName);
                 });
            });

            // Prioritize containers with ports if multiple matches (though improbable with infra gone)
            let container = candidates.find(c => c.ports && c.ports.length > 0);
            
            if (!container && candidates.length > 0) {
                 container = candidates[0];
            }

            if (baseName === 'adguard' || baseName.includes('adguard') || baseName.includes('immich')) {
                logger.debug('ServiceManager', `Processing ${baseName}`);
                logger.debug('ServiceManager', `STRICT Expected Names: ${uniqueExpected.join(', ')}`);
                logger.debug('ServiceManager', `Candidates found: ${candidates.length}`);
                if (container) logger.debug('ServiceManager', `Selected: ${container.names?.join(', ')}`);
            }

            // Find Verified Domains
            const verifiedDomains = (proxyState?.routes || [])
                .filter(r => {
                    const target = r.targetService.split(':')[0]; // Strip port
                    if (target === baseName) return true;
                    if (container && container.names) {
                        return container.names.some(n => n.replace(/^\//, '') === target);
                    }
                    return false;
                })
                .map(r => r.host);
            
            // Generate ServiceInfo
            const info: ServiceInfo = {
                name: baseName,
                id: baseName,
                // Files are watched, so path is available
                kubeFile: fileName,
                kubePath: filePath,
                yamlFile: yamlFile,
                yamlPath: yamlPath,
                active: serviceUnit?.activeState === 'active' || (serviceUnit?.active ?? false), // Use boolean flag if available
                status: serviceUnit ? serviceUnit.activeState : 'inactive',
                description: serviceUnit?.description || '',
                labels: container?.labels || {},
                ports: container ? container.ports.map((p) => ({
                   host: String(p.hostPort), // Handle V4 camelCase (Strict)
                   container: String(p.containerPort)
                })) : [],
                volumes: [], // Populate if needed from twin.volumes
                hostNetwork: false, // Infer
                node: nodeName,
                verifiedDomains: verifiedDomains
            };

            if (serviceUnit) {
                info.isReverseProxy = serviceUnit.isReverseProxy;
                info.isServiceBay = serviceUnit.isServiceBay;
            }

            // Parse File Content for metadata like Yaml path
            // (We re-use yamlContent from above if parsed)
            if (type === 'kube' && yamlContent) {
                 // Already parsed above broadly, now strictly for metadata
                     if (yamlContent) {
                         try {
                              // Use Cache (guaranteed populated from above block if yamlContent exists)
                              const cacheKey = `${nodeName}:${yamlPath}`;
                              const cached = ServiceManager.fileParseCache.get(cacheKey);
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              const docs = (cached && cached.hash === yamlContent) ? cached.parsed : (yaml.loadAll(yamlContent) as any[]);

                             for (const doc of docs) {
                                 if (!doc) continue;
                                 
                                 // Labels (Merge with container labels)
                                 if (doc.metadata?.labels) {
                                     info.labels = { ...info.labels, ...doc.metadata.labels };
                                 }

                                 // Annotations — servicebay.ports declares which ports belong to this service.
                                 // Merge with runtime ports (annotation ports take priority, runtime ports are added if not already present).
                                 const portsAnnotation = doc.metadata?.annotations?.['servicebay.ports'];
                                 if (portsAnnotation) {
                                     const annotatedPorts: typeof info.ports = [];
                                     // Format: "8083/tcp,53/udp,53/tcp"
                                     for (const entry of String(portsAnnotation).split(',')) {
                                         const [portStr] = entry.trim().split('/');
                                         const port = portStr.trim();
                                         if (port) {
                                             annotatedPorts.push({ host: port, container: port });
                                         }
                                     }
                                     // Merge: annotated ports first, then any runtime ports not already listed
                                     const annotatedSet = new Set(annotatedPorts.map(p => String(p.host)));
                                     const extraRuntimePorts = info.ports.filter(p => !annotatedSet.has(String(p.host)));
                                     info.ports = [...annotatedPorts, ...extraRuntimePorts];
                                 }

                                 // Spec
                                 if (doc.spec) {
                                     // Host Network
                                     if (doc.spec.hostNetwork) info.hostNetwork = true;
                                     
                                     // Ports (Fallback if container not providing them)
                                     if (doc.spec.containers && info.ports.length === 0) {
                                         // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                         doc.spec.containers.forEach((c: any) => {
                                             if (c.ports) {
                                                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                 c.ports.forEach((p: any) => {
                                                     let host = p.hostPort ? String(p.hostPort) : undefined;
                                                     const container = String(p.containerPort);
                                                     
                                                     // If Host Network, container port IS host port
                                                     if (!host && (info.hostNetwork || doc.spec.hostNetwork)) {
                                                         host = container;
                                                     }
                                                     
                                                     info.ports.push({ host, container });
                                                 });
                                             }

                                             // Volumes (Kube)
                                             if (c.volumeMounts && doc.spec.volumes) {
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                c.volumeMounts.forEach((m: any) => {
                                                    // Find matching volume definition to get host path or claim
                                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                    const volDef = doc.spec.volumes.find((v: any) => v.name === m.name);
                                                    let host = '';
                                                    if (volDef) {
                                                        if (volDef.hostPath) host = volDef.hostPath.path;
                                                        else if (volDef.persistentVolumeClaim) host = `pvc:${volDef.persistentVolumeClaim.claimName}`;
                                                        else host = 'volume:' + m.name;
                                                    }
                                                    info.volumes.push({ host, container: m.mountPath });
                                                });
                                             }
                                         });
                                     }
                                 }
                             }
                         } catch (e) {
                             logger.warn('ServiceManager', `Failed to parse YAML for ${baseName}`, e);
                         }
                     }
            }

            // Parse Container/Quadlet for metadata
            if (type === 'container' && file.content) {
                // Parse INI-like content
                const lines = file.content.split('\n');
                let inContainerSection = false;
                
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === '[Container]') {
                        inContainerSection = true;
                        continue;
                    }
                    if (trimmed.startsWith('[')) {
                        inContainerSection = false;
                        continue;
                    }
                    
                    if (inContainerSection) {
                        // Network
                        if (trimmed.startsWith('Network=host')) {
                            info.hostNetwork = true;
                        }
                        
                        // Ports: PublishPort=8080:80
                        if (trimmed.startsWith('PublishPort=')) {
                            const val = trimmed.split('=')[1];
                            if (val && info.ports.length === 0) {
                                // 80:80 or 80 (implicitly host?)
                                const parts = val.split(':');
                                if (parts.length === 2) {
                                    info.ports.push({ host: parts[0], container: parts[1] });
                                } else {
                                    info.ports.push({ host: parts[0], container: parts[0] });
                                }
                            }
                        }

                        // Volumes: Volume=/host:/container
                        if (trimmed.startsWith('Volume=')) {
                            const val = trimmed.split('=')[1];
                            if (val) {
                                const parts = val.split(':');
                                if (parts.length >= 2) {
                                    // Handle /host:/container:Z or /host:/container
                                    // Quadlet format: host-path:container-path[:options]
                                    info.volumes.push({ host: parts[0], container: parts[1] });
                                }
                            }
                        }
                        
                        // Labels: Label=key=value
                        if (trimmed.startsWith('Label=')) {
                           const val = trimmed.substring(6); // remove Label=
                           const firstEq = val.indexOf('=');
                           if (firstEq > -1) {
                               const k = val.substring(0, firstEq);
                               const v = val.substring(firstEq + 1);
                               // Only set if not already present from container runtime
                               if (!info.labels[k]) {
                                   info.labels[k] = v;
                               }
                           }
                        }
                    }
                }
            }

            services.push(info);
        }

        // --- Implicit Services (System-Managed or Source-Built) ---
        // Nginx (Reverse Proxy) and ServiceBay often don't have .kube/.container files in user config
        // but we still want to visualize them if they are detected by the Agent.
        
        const processedIds = new Set(services.map(s => s.id));
        const specialServices = twin.services.filter(s => 
            (s.isReverseProxy || s.isServiceBay) && !processedIds.has(s.name)
        );

        for (const serviceUnit of specialServices) {
            const baseName = serviceUnit.name; // e.g. nginx-web (agent strips .service)
            // Determine expected container names for these system services
            const expectedNames = [baseName];
            
            // Special aliases
            if (serviceUnit.isReverseProxy) {
                expectedNames.push(baseName);
                expectedNames.push('nginx');
                expectedNames.push('nginx-web');
                expectedNames.push('systemd-nginx');
                expectedNames.push('systemd-nginx-web');
            }
            if (serviceUnit.isServiceBay) {
                expectedNames.push('servicebay');
                expectedNames.push('servicebay-dev');
            }

            // Find Container
            const candidates = twin.containers.filter(c => {
                 if (!c.names) return false;
                 return c.names.some(n => {
                     const cleanName = n.replace(/^\//, '');
                     return expectedNames.includes(cleanName);
                 });
            });
            const container = candidates[0]; // Simple best match

            const isProxy = serviceUnit?.isReverseProxy ?? (proxyState?.provider === 'nginx' && (baseName === 'nginx-web' || baseName === 'nginx'));
            const isServiceBay = serviceUnit?.isServiceBay ?? (baseName === 'servicebay');

            // Find Verified Domains
            const verifiedDomains = (proxyState?.routes || [])
                .filter(r => {
                    const target = r.targetService.split(':')[0]; // Strip port
                    if (target === baseName) return true; // Matches service name
                    if (target === 'nginx' && isProxy) return true; // Matches implicit proxy name
                    if (container && container.names) {
                        return container.names.some(n => n.replace(/^\//, '') === target);
                    }
                    return false;
                })
                .map(r => r.host);

            services.push({
                name: baseName,
                id: baseName,
                kubeFile: '', // Virtual
                kubePath: '',
                yamlFile: null,
                yamlPath: null,
                active: serviceUnit.activeState === 'active' || (serviceUnit.active ?? false),
                status: serviceUnit.activeState,
                description: serviceUnit.description || '',
                labels: container?.labels || {},
                ports: container ? container.ports.map((p) => ({
                   host: String(p.hostPort),
                   container: String(p.containerPort)
                })) : [],
                volumes: [],
                hostNetwork: false,
                node: nodeName,
                isReverseProxy: isProxy,
                isServiceBay: isServiceBay,
                verifiedDomains: verifiedDomains
            });
        }
        
        return services;
    }
    // `--no-block` returns immediately after dispatching the start/restart
    // request to systemd; image pulls and container creation continue in the
    // background, governed by the unit's `TimeoutStartSec` (set to 600s for
    // multi-image pods in `injectServiceTimeout`). Without this flag a fresh
    // deploy with several large images would block the SSH channel for
    // minutes and cause subsequent agent commands (write_file for the next
    // service's .kube file) to time out and never get sent.
    static async startService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block start ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async stopService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block stop ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async restartService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
         const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block restart ${serviceName}.service` });
         if (res.code !== 0) throw new Error(res.stderr);
    }

    static async reloadDaemon(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: 'systemctl --user daemon-reload' });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async writeFile(nodeName: string, filename: string, content: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const targetPath = `~/.config/containers/systemd/${filename}`;
        const res = await agent.sendCommand('write_file', { path: targetPath, content });
        if (res !== "ok") throw new Error('Failed to write ' + filename);
    }

    static async ensurePodmanSocket(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        try {
            const res = await agent.sendCommand('exec', { command: 'systemctl --user enable --now podman.socket' });
            if (res.code === 0) {
                logger.info('ServiceManager', 'podman.socket enabled');
            } else {
                logger.warn('ServiceManager', 'Failed to enable podman.socket:', res.stderr);
            }
        } catch (e) {
            logger.warn('ServiceManager', 'Error enabling podman.socket:', e);
        }
    }

    /** Allow rootless Podman to bind privileged ports (e.g. 445 for SMB). Idempotent. */
    static async ensureUnprivilegedPorts(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        try {
            const check = await agent.sendCommand('exec', { command: 'cat /proc/sys/net/ipv4/ip_unprivileged_port_start' });
            if (check.code === 0 && parseInt(check.stdout.trim(), 10) === 0) return;
            // Set at runtime
            await agent.sendCommand('exec', { command: 'sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0' });
            // Persist across reboots
            await agent.sendCommand('exec', {
                command: 'echo "net.ipv4.ip_unprivileged_port_start=0" | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf > /dev/null'
            });
            logger.info('ServiceManager', 'Enabled unprivileged port binding (sysctl)');
        } catch (e) {
            logger.warn('ServiceManager', 'Error setting unprivileged port sysctl:', e);
        }
    }

    /**
     * Stacks that were renamed or merged at some point. Mapping: new name →
     * the OLD systemd-unit names whose quadlet files should be soft-deleted
     * before re-deploy.
     *
     * Without this, an in-place upgrade from a pre-rename release leaves
     * orphan `<old>.kube` units running alongside the new merged pod. The
     * wizard surfaces them as restart-looping ghosts (because the *new* pod
     * grabs the host ports the old one wanted) and the operator has to
     * clean up by hand. The trashed predecessor files are recoverable from
     * `~/.config/containers/systemd/.trash/` for 7 days, so this is safe.
     */
    static readonly STACK_MIGRATIONS: Record<string, string[]> = {
        'auth':           ['authelia', 'lldap'],
        'media':          ['audiobookshelf', 'navidrome'],
        'home-assistant': ['home-assistant-stack'],
        'file-share':     ['filebrowser'],
    };

    private static async migratePredecessors(
        nodeName: string,
        newName: string,
        onProgress?: (message: string) => void,
    ): Promise<void> {
        const predecessors = ServiceManager.STACK_MIGRATIONS[newName] ?? [];
        if (predecessors.length === 0) return;
        const agent = await agentManager.ensureAgent(nodeName);
        for (const old of predecessors) {
            // Cheap existence check — if the kube unit isn't on disk there's
            // nothing to migrate. Skip silently to keep fresh-install logs clean.
            const check = await agent.sendCommand('exec', {
                command: `test -f ~/${SYSTEMD_DIR}/${old}.kube && echo present || echo absent`,
            });
            if ((check.stdout || '').trim() !== 'present') continue;
            onProgress?.(`Migrating predecessor: soft-deleting ${old} (replaced by ${newName})`);
            logger.info('ServiceManager', `Soft-deleting predecessor "${old}" before deploying "${newName}"`);
            try {
                await ServiceManager.deleteService(nodeName, old);
            } catch (e) {
                // Non-fatal — if the old unit can't be cleaned, the deploy
                // below either succeeds (different ports / pod name) or
                // fails loudly via the port-collision pre-flight.
                logger.warn('ServiceManager', `Failed to soft-delete predecessor ${old}:`, e);
            }
        }
    }

    static async deployKubeService(nodeName: string, name: string, kubeContent: string, yamlContent: string, yamlName: string, extraFiles?: { path: string; content: string }[], onProgress?: (message: string) => void) {
        // Migrate any pre-rename predecessor units first so their host-port
        // ownership is released before the port-collision pre-flight runs.
        await ServiceManager.migratePredecessors(nodeName, name, onProgress);

        // Pre-flight: refuse to deploy if the YAML claims a host port that
        // another service on the same node already owns. Without this check,
        // the second deploy "succeeds" but the unit fails to start because the
        // bind() races; users only notice when the new service stays
        // permanently inactive in the dashboard.
        const collisions = await this.findHostPortCollisions(nodeName, name, yamlContent);
        if (collisions.length > 0) {
            const detail = collisions
                .map(c => `port ${c.hostPort} already in use by ${c.serviceName}`)
                .join('; ');
            throw new Error(`Port collision on node "${nodeName}": ${detail}. Change the host port and retry.`);
        }

        // Inject the default systemd directives (TimeoutStartSec for slow
        // image pulls + Restart=on-failure with exponential backoff) into
        // every .kube unit, single-image or multi-image. The previous
        // multi-image-only gate was a leftover from when only the
        // TimeoutStartSec was injected; it caused single-image services
        // (radicale, filebrowser, nginx-web, …) to land *without* any
        // restart directives, so a transient image-pull failure or any
        // crash put the unit permanently in `failed` state with no auto-
        // recovery. injectServiceDirectives is idempotent per-directive,
        // so re-deploys never duplicate keys.
        kubeContent = injectServiceDirectives(kubeContent);

        const images = this.extractImages(yamlContent);

        await this.writeFile(nodeName, yamlName, yamlContent);
        await this.writeFile(nodeName, `${name}.kube`, kubeContent);
        await this.ensurePodmanSocket(nodeName);

        // Write extra config files (e.g. Authelia configuration.yml) to the node filesystem.
        // Failures here are FATAL — the previous behaviour was to log a warning
        // and continue, which produced the radicale crash-loop class of bug:
        // service starts, looks for a config file that's not there, dies, and
        // the operator has no breadcrumb back to the real cause (the silent
        // write_file failure during deploy). Raising here surfaces the
        // problem at deploy time with a useful path.
        if (extraFiles?.length) {
            const agent = await agentManager.ensureAgent(nodeName);
            const failures: string[] = [];
            for (const f of extraFiles) {
                // Ensure parent directory exists
                const dir = f.path.substring(0, f.path.lastIndexOf('/'));
                if (dir) {
                    await agent.sendCommand('exec', { command: `mkdir -p ${dir}` });
                }
                const res = await agent.sendCommand('write_file', { path: f.path, content: f.content });
                if (res !== 'ok') {
                    failures.push(f.path);
                    logger.error('ServiceManager', `Failed to write extra file ${f.path}: agent returned ${JSON.stringify(res)}`);
                } else {
                    logger.info('ServiceManager', `Wrote extra config file: ${f.path}`);
                }
            }
            if (failures.length > 0) {
                throw new Error(
                    `Failed to write ${failures.length} required config file(s) for service "${name}":\n  ${failures.join('\n  ')}\n\n` +
                    `The service was not started. Re-run the deploy or check the agent's write permissions on the target paths.`,
                );
            }
        }

        // Ensure unprivileged port binding if any port < 1024 is used
        if (this.hasPrivilegedPorts(yamlContent)) {
            await this.ensureUnprivilegedPorts(nodeName);
        }

        await this.reloadDaemon(nodeName);

        // Pre-pull all images before starting to avoid systemd timeout
        await this.prePullImages(nodeName, images, onProgress ? (image, idx, total, evt) => {
            if (evt.id && evt.status) {
                if (evt.total && evt.current !== undefined) {
                    const pct = Math.round(evt.current / evt.total * 100);
                    const currentMB = (evt.current / 1048576).toFixed(1);
                    const totalMB = (evt.total / 1048576).toFixed(1);
                    onProgress(`Pulling image ${idx + 1}/${total}: ${image} — ${evt.id.slice(0, 12)}: ${evt.status} ${currentMB} MB / ${totalMB} MB (${pct}%)`);
                } else {
                    onProgress(`Pulling image ${idx + 1}/${total}: ${image} — ${evt.id.slice(0, 12)}: ${evt.status}`);
                }
            }
        } : undefined);

        // Fix volume ownership for containers running as non-root UIDs
        await this.fixVolumeOwnership(nodeName, yamlContent);

        // Run pre-start hooks (e.g. initialize databases with known credentials)
        await this.runPreStartHooks(nodeName, name, yamlContent);

        // Attempt start, but don't fail deployment if start fails (user can check logs)
        try {
             await this.startService(nodeName, name);
        } catch(e) {
             logger.warn('ServiceManager', `Service ${name} deployed but start failed:`, e);
        }
        this.backupQuadlets(nodeName);

        // Create health check for the new service if one doesn't exist
        try {
            const { HealthStore } = await import('../health/store');
            const checks = HealthStore.getChecks();
            const alreadyMonitored = checks.some(c =>
                (c.type === 'service' && c.target === name) ||
                (c.name === `Service: ${name}`)
            );
            if (!alreadyMonitored) {
                const crypto = await import('crypto');
                HealthStore.saveCheck({
                    id: crypto.randomUUID(),
                    name: `Service: ${name}`,
                    type: 'service',
                    target: name,
                    interval: 60,
                    enabled: true,
                    created_at: new Date().toISOString(),
                    nodeName: nodeName !== 'Local' ? nodeName : undefined,
                });
                logger.info('ServiceManager', `Created health check for ${name}`);
            }
        } catch (e) {
            logger.warn('ServiceManager', `Failed to create health check for ${name}:`, e);
        }
    }

    /**
     * Pull every hostPort declared in a kube YAML. Tolerates malformed YAML
     * (returns empty rather than throwing) so a parse error never blocks a
     * deploy via the collision check.
     */
    static extractHostPorts(yamlContent: string): number[] {
        const ports = new Set<number>();
        try {
            const docs = yaml.loadAll(yamlContent) as unknown[];
            for (const doc of docs) {
                if (!doc || typeof doc !== 'object') continue;
                const spec = (doc as { spec?: unknown }).spec as { containers?: unknown } | undefined;
                const containers = Array.isArray(spec?.containers) ? spec.containers : [];
                for (const c of containers) {
                    if (!c || typeof c !== 'object') continue;
                    const portsField = (c as { ports?: unknown }).ports;
                    if (!Array.isArray(portsField)) continue;
                    for (const p of portsField) {
                        if (!p || typeof p !== 'object') continue;
                        const hp = (p as { hostPort?: unknown }).hostPort;
                        if (typeof hp === 'number' && Number.isFinite(hp) && hp > 0) {
                            ports.add(hp);
                        } else if (typeof hp === 'string') {
                            const n = parseInt(hp, 10);
                            if (Number.isFinite(n) && n > 0) ports.add(n);
                        }
                    }
                }
            }
        } catch {
            // Fallback: regex out hostPort: <num>. Better to under-detect than crash.
            const regex = /hostPort:\s*["']?(\d+)["']?/g;
            let m: RegExpExecArray | null;
            while ((m = regex.exec(yamlContent)) !== null) {
                const n = parseInt(m[1], 10);
                if (Number.isFinite(n) && n > 0) ports.add(n);
            }
        }
        return [...ports];
    }

    /**
     * Look for hostPort conflicts between a yaml-being-deployed and the
     * services currently registered on `nodeName`. The service being
     * (re)deployed under `selfName` is excluded so an upgrade in place is
     * never blocked by its own already-registered ports.
     */
    static async findHostPortCollisions(
        nodeName: string,
        selfName: string,
        yamlContent: string,
    ): Promise<{ hostPort: number; serviceName: string }[]> {
        const wanted = this.extractHostPorts(yamlContent);
        if (wanted.length === 0) return [];
        const services = await this.listServices(nodeName);
        const collisions: { hostPort: number; serviceName: string }[] = [];
        for (const port of wanted) {
            for (const svc of services) {
                if (svc.name === selfName) continue;
                const hit = svc.ports?.some(p => {
                    if (!p?.host) return false;
                    return parseInt(p.host, 10) === port;
                });
                if (hit) {
                    collisions.push({ hostPort: port, serviceName: svc.name });
                    break;
                }
            }
        }
        return collisions;
    }

    /** Extract all container image references from a kube YAML */
    private static extractImages(yamlContent: string): string[] {
        const images: string[] = [];
        const regex = /^\s*image:\s*(.+)$/gm;
        let match;
        while ((match = regex.exec(yamlContent)) !== null) {
            const img = match[1].trim().replace(/["']/g, '');
            if (img && !img.startsWith('{{')) images.push(img);
        }
        return [...new Set(images)];
    }

    /** Check if any hostPort < 1024 is defined in the YAML */
    private static hasPrivilegedPorts(yamlContent: string): boolean {
        if (yamlContent.includes('hostNetwork: true')) return true;
        const regex = /hostPort:\s*(\d+)/g;
        let match;
        while ((match = regex.exec(yamlContent)) !== null) {
            if (parseInt(match[1], 10) < 1024) return true;
        }
        return false;
    }

    // Default systemd directives (TimeoutStartSec, restart backoff, etc.)
    // live in `quadletDirectives.ts` so other kube-write paths can use the
    // same transform without importing this whole class.

    /** Pre-pull container images so systemd start doesn't timeout */
    static async prePullImages(
        nodeName: string,
        images: string[],
        onProgress?: (image: string, imageIndex: number, total: number, event: import('../agent/handler').PullProgressEvent) => void
    ) {
        const agent = await agentManager.ensureAgent(nodeName);
        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            try {
                logger.info('ServiceManager', `Pre-pulling image: ${image}`);
                await agent.pullImage(image, onProgress ? (evt) => onProgress(image, i, images.length, evt) : undefined);
            } catch (e) {
                logger.warn('ServiceManager', `Failed to pre-pull ${image} (will retry on start):`, e);
            }
        }
    }

    /** Fix volume ownership for containers with explicit runAsUser/runAsGroup.
     *  In rootless podman, host UIDs map differently inside the user namespace.
     *  Uses `podman unshare chown` to translate container UIDs to correct host UIDs. */
    private static async fixVolumeOwnership(nodeName: string, yamlContent: string) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docs = yaml.loadAll(yamlContent) as any[];
            for (const doc of docs) {
                if (!doc?.spec) continue;
                const containers = doc.spec.containers || [];
                const volumes = doc.spec.volumes || [];

                // Build volume name -> hostPath map
                const volumePaths = new Map<string, string>();
                for (const vol of volumes) {
                    if (vol.hostPath?.path) {
                        volumePaths.set(vol.name, vol.hostPath.path);
                    }
                }

                for (const container of containers) {
                    const uid = container.securityContext?.runAsUser;
                    const gid = container.securityContext?.runAsGroup ?? uid;
                    if (uid == null || uid === 0) continue; // Skip root or unset

                    const mounts = container.volumeMounts || [];
                    for (const mount of mounts) {
                        const hostPath = volumePaths.get(mount.name);
                        if (!hostPath || mount.readOnly) continue;

                        const agent = await agentManager.ensureAgent(nodeName);
                        try {
                            await agent.sendCommand('exec', {
                                command: `podman unshare chown -R ${uid}:${gid} ${hostPath}`
                            });
                            logger.info('ServiceManager', `Fixed volume ownership: ${hostPath} -> ${uid}:${gid}`);
                        } catch (e) {
                            logger.warn('ServiceManager', `Failed to fix ownership for ${hostPath}:`, e);
                        }
                    }
                }
            }
        } catch (e) {
            logger.debug('ServiceManager', 'Volume ownership fix skipped:', e);
        }
    }

    /**
     * Run pre-start hooks for known images that need initialization (e.g. filebrowser DB).
     * This runs AFTER files are written and images are pulled, but BEFORE the service starts.
     */
    private static async runPreStartHooks(nodeName: string, name: string, yamlContent: string) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docs = yaml.loadAll(yamlContent) as any[];
            for (const doc of docs) {
                if (!doc?.spec) continue;
                const containers = doc.spec.containers || [];
                const volumes = doc.spec.volumes || [];

                const volumePaths = new Map<string, string>();
                for (const vol of volumes) {
                    if (vol.hostPath?.path) volumePaths.set(vol.name, vol.hostPath.path);
                }

                for (const container of containers) {
                    const image = container.image || '';
                    if (!image.includes('filebrowser')) continue;

                    // Find the database volume mount
                    const dbMount = (container.volumeMounts || []).find(
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (m: any) => m.mountPath === '/db'
                    );
                    const dbHostPath = dbMount ? volumePaths.get(dbMount.name) : null;
                    if (!dbHostPath) continue;

                    // Extract password from --database arg or use default path
                    const dbFile = 'filebrowser.db';
                    const fullDbPath = `${dbHostPath}/${dbFile}`;

                    const agent = await agentManager.ensureAgent(nodeName);

                    // Check if DB already exists (don't overwrite on redeploy)
                    const check = await agent.sendCommand('exec', { command: `test -f ${fullDbPath} && echo exists` });
                    if (check.stdout?.trim() === 'exists') {
                        logger.debug('ServiceManager', `FileBrowser DB already exists at ${fullDbPath}, skipping init`);
                        continue;
                    }

                    // Initialize filebrowser DB with known admin password using a temporary container
                    logger.info('ServiceManager', `Initializing FileBrowser DB at ${fullDbPath}`);
                    await agent.sendCommand('exec', { command: `mkdir -p ${dbHostPath}` });
                    const initCmd = [
                        `podman run --rm --user 0:0`,
                        `-v ${dbHostPath}:/db`,
                        `${image}`,
                        `config init --database /db/${dbFile}`,
                    ].join(' ');
                    await agent.sendCommand('exec', { command: initCmd, timeout: 60 });

                    const userCmd = [
                        `podman run --rm --user 0:0`,
                        `-v ${dbHostPath}:/db`,
                        `${image}`,
                        `users add admin admin1234admin --perm.admin --database /db/${dbFile}`,
                    ].join(' ');
                    const result = await agent.sendCommand('exec', { command: userCmd, timeout: 60 });
                    if (result.code === 0) {
                        logger.info('ServiceManager', 'FileBrowser initialized with admin/admin1234admin');
                    } else {
                        logger.warn('ServiceManager', `FileBrowser user init failed: ${result.stderr}`);
                    }
                }
            }
        } catch (e) {
            logger.debug('ServiceManager', 'Pre-start hooks skipped:', e);
        }
    }

    static async deployService(nodeName: string, filename: string, content: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const targetPath = `~/.config/containers/systemd/${filename}`;

        // agent.py "write_file" returns "ok"
        const res = await agent.sendCommand('write_file', { path: targetPath, content });
        if (res !== "ok") {
             throw new Error('Failed to write service file');
        }

        await this.ensurePodmanSocket(nodeName);
        await this.reloadDaemon(nodeName);
        this.backupQuadlets(nodeName);
    }

    static async removeService(nodeName: string, filename: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        // Use variable to avoid quoting issues
        const cmd = `
        f="$HOME/.config/containers/systemd/${filename}"
        if [ -f "$f" ]; then rm -f "$f"; fi
        `;
        const res = await agent.sendCommand('exec', { command: cmd });
         if (res.code !== 0) throw new Error(res.stderr);

        await this.reloadDaemon(nodeName);
        this.backupQuadlets(nodeName);
    }

    /** Backup Quadlet files to data directory (survives OS reinstall).
     *  Note: nginx config already lives on DATA_DIR (RAID) and needs no extra backup here.
     *  It is included in the downloadable full system backup (systemBackup.ts). */
    private static async backupQuadlets(nodeName: string) {
        try {
            const config = await getConfig();
            const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';
            const backupDir = `${dataDir}/servicebay/quadlet-backup`;
            const quadletDir = '$HOME/.config/containers/systemd';
            const agent = await agentManager.ensureAgent(nodeName);
            await agent.sendCommand('exec', {
                command: `mkdir -p ${backupDir} && rsync -a --delete --include='*.kube' --include='*.yml' --include='*.container' --exclude='*' ${quadletDir}/ ${backupDir}/ 2>/dev/null || true`
            });
            logger.info('ServiceManager', `Quadlet backup synced for ${nodeName}`);
        } catch (e) {
            logger.debug('ServiceManager', 'Quadlet backup skipped:', e);
        }
    }

    /** Trigger an agent refresh so the Digital Twin picks up changes immediately */
    private static async refreshAgent(nodeName: string) {
        try {
            const agent = await agentManager.ensureAgent(nodeName);
            await agent.sendCommand('refresh');
        } catch { /* agent may not be connected */ }
    }

    static async getServiceFiles(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const kubePath = path.join(SYSTEMD_DIR, `${serviceName}.kube`);
        let kubeContent = '';
        let yamlContent = '';
        let yamlPath = '';
        let serviceContent = '';
        let servicePath = '';

        try {
            // First try reading from the Digital Twin cache
            const { DigitalTwinStore } = await import('../store/twin');
            const twin = DigitalTwinStore.getInstance().nodes[nodeName];

            const fullKubePath = twin ? Object.keys(twin.files).find(p => p.endsWith(`${serviceName}.kube`)) : null;

            if (twin && fullKubePath && twin.files[fullKubePath]?.content) {
                kubeContent = twin.files[fullKubePath].content;
            } else {
                // Don't blindly read_file unknown service names. When a network
                // map ghost node (e.g. "Local Service 3000") gets clicked and
                // its display label leaks into here, the read_file fails on
                // the agent and the failure surfaces as the agent's
                // user-visible `lastError`. Validate that the service is
                // actually known to systemd before paying that cost.
                if (twin && twin.services?.length) {
                    const exists = twin.services.some((s: { name: string }) => s.name === serviceName);
                    if (!exists) {
                        throw new Error(`Service ${serviceName} not found on ${nodeName}`);
                    }
                }
                const res = await agent.sendCommand('read_file', { path: `~/${kubePath}` });
                kubeContent = extractFileContent(res);
            }

            const yamlMatch = kubeContent.match(/Yaml=(.+)/);
            if (yamlMatch) {
                const yamlFileName = yamlMatch[1].trim();
                yamlPath = yamlFileName.startsWith('/') ? yamlFileName : path.join(SYSTEMD_DIR, yamlFileName);

                // Try twin first
                const fullYamlPath = twin ? Object.keys(twin.files).find(p => p.endsWith(yamlFileName)) : null;
                if (twin && fullYamlPath && twin.files[fullYamlPath]?.content) {
                    yamlContent = twin.files[fullYamlPath].content;
                } else {
                    try {
                        const res = await agent.sendCommand('read_file', { path: `~/${yamlPath}` });
                        yamlContent = extractFileContent(res);
                    } catch (e) {
                        logger.warn('ServiceManager', `Could not read yaml file ${yamlPath}`, e);
                    }
                }
            }

            // Get generated service unit content
            try {
                const catRes = await agent.sendCommand('exec', { command: `systemctl --user cat ${serviceName}.service` });
                serviceContent = catRes.code === 0 ? catRes.stdout : '# Service unit not found or not generated yet.';

                const pathRes = await agent.sendCommand('exec', { command: `systemctl --user show -p FragmentPath ${serviceName}.service` });
                if (pathRes.code === 0) {
                    const match = pathRes.stdout.match(/FragmentPath=(.+)/);
                    if (match) servicePath = match[1].trim();
                }
            } catch {
                serviceContent = '# Service unit not found or not generated yet.';
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Service ${serviceName} not found: ${msg}`);
        }

        return { kubeContent, yamlContent, yamlPath, serviceContent, kubePath, servicePath };
    }

    static async saveService(nodeName: string, serviceName: string, kubeContent: string, yamlContent: string, yamlFileName: string) {
        // Save snapshots of existing files before overwriting
        try {
            const existing = await this.getServiceFiles(nodeName, serviceName);
            if (existing.kubeContent) await saveSnapshot(`${serviceName}.kube`, existing.kubeContent);
            if (existing.yamlContent) await saveSnapshot(yamlFileName, existing.yamlContent);
        } catch { /* ignore if new file */ }

        await this.writeFile(nodeName, `${serviceName}.kube`, kubeContent);
        await this.writeFile(nodeName, yamlFileName, yamlContent);
        await this.reloadDaemon(nodeName);
        await this.refreshAgent(nodeName);
        this.backupQuadlets(nodeName);
    }

    /**
     * Soft-delete a service: stop the unit, then *move* its .kube and .yml
     * files into ~/.config/containers/systemd/.trash/<ts>-<name>/ instead
     * of deleting them. The operator (or an MCP client) can `restore_from_trash`
     * to undo within 7 days; `purge_trash` actually removes them. Auto-purge
     * older than 7 days runs on server startup.
     *
     * Why "move, don't rm": delete-by-mistake is the easiest way to lose
     * service config, and the existing system-backup mechanism only takes
     * snapshots periodically. A trash bucket gives an immediate one-step
     * recovery without restoring from a backup tarball.
     */
    static async deleteService(nodeName: string, serviceName: string) {
        const { yamlPath } = await this.getServiceFiles(nodeName, serviceName);
        const agent = await agentManager.ensureAgent(nodeName);

        // Stop
        try {
            await agent.sendCommand('exec', { command: `systemctl --user stop ${serviceName}.service` });
        } catch { /* ignore if already stopped */ }

        // Move the files into the trash bucket. ISO-8601 with no colons in
        // the name so it sorts by timestamp and survives shells that hate
        // colons in paths.
        const trashStamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = `~/${SYSTEMD_DIR}/.trash/${trashStamp}-${serviceName}`;
        await agent.sendCommand('exec', { command: `mkdir -p '${trashDir}'` });

        // Move kube file
        await agent.sendCommand('exec', {
            command: `mv -f ~/${SYSTEMD_DIR}/${serviceName}.kube '${trashDir}/' 2>/dev/null || true`
        });

        // Move yaml file
        if (yamlPath) {
            const resolvedYaml = yamlPath.startsWith('/') ? yamlPath : `~/${yamlPath}`;
            await agent.sendCommand('exec', {
                command: `mv -f ${resolvedYaml} '${trashDir}/' 2>/dev/null || true`,
            });
        }

        // Stash a small manifest so restore knows the original yaml path
        // even if it lived outside the systemd dir (legacy migrations did).
        const manifest = JSON.stringify({
            service: serviceName,
            deletedAt: new Date().toISOString(),
            originalYamlPath: yamlPath || null,
            originalKubePath: `~/${SYSTEMD_DIR}/${serviceName}.kube`,
        });
        await agent.sendCommand('exec', {
            command: `printf '%s' ${JSON.stringify(manifest)} > '${trashDir}/.manifest.json'`,
        });

        await this.reloadDaemon(nodeName);

        // Clear failed state
        try {
            await agent.sendCommand('exec', { command: `systemctl --user reset-failed ${serviceName}.service` });
        } catch { /* unit may not be in failed state */ }

        await this.refreshAgent(nodeName);
        this.backupQuadlets(nodeName);

        logger.info('ServiceManager', `Soft-deleted ${serviceName} on ${nodeName} → ${trashDir}`);
    }

    /** Recursive listing of the trash bucket for one node. Each entry maps
     *  to a single soft-deleted service. */
    static async listTrashedServices(nodeName: string): Promise<Array<{
        id: string;
        service: string;
        deletedAt: string;
        path: string;
    }>> {
        const agent = await agentManager.ensureAgent(nodeName);
        const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
        try {
            const res = await agent.sendCommand('exec', {
                command: `ls -1 ${trashRoot} 2>/dev/null`,
            });
            const out = (res?.stdout ?? '') as string;
            const entries = out.trim().split('\n').filter(Boolean);
            const results = [];
            for (const entry of entries) {
                let manifest: { service?: string; deletedAt?: string } = {};
                try {
                    const m = await agent.sendCommand('exec', {
                        command: `cat '${trashRoot}/${entry}/.manifest.json' 2>/dev/null`,
                    });
                    manifest = JSON.parse(((m?.stdout ?? '') as string) || '{}');
                } catch { /* fall back to filename parse */ }
                // Fallback: derive from directory name "<iso-stamp>-<service>"
                const fallback = entry.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)-(.+)$/);
                results.push({
                    id: entry,
                    service: manifest.service || fallback?.[2] || entry,
                    deletedAt: manifest.deletedAt || (fallback ? fallback[1].replace(/-(\d\d)-(\d\d)Z$/, ':$1:$2Z') : ''),
                    path: `${trashRoot}/${entry}`,
                });
            }
            return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
        } catch {
            return [];
        }
    }

    /** Restore a soft-deleted service from trash. Moves the files back to
     *  their original locations and reloads systemd. */
    static async restoreTrashedService(nodeName: string, trashId: string): Promise<{ service: string }> {
        const agent = await agentManager.ensureAgent(nodeName);
        const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
        const trashDir = `${trashRoot}/${trashId}`;

        // Read manifest. Manifest is the source of truth for original
        // paths because the service may have referenced a yaml file
        // outside SYSTEMD_DIR.
        const m = await agent.sendCommand('exec', {
            command: `cat '${trashDir}/.manifest.json' 2>/dev/null`,
        });
        let manifest: { service?: string; originalYamlPath?: string | null; originalKubePath?: string };
        try {
            manifest = JSON.parse(((m?.stdout ?? '') as string) || '{}');
        } catch {
            throw new Error(`Trash entry ${trashId} is missing or has a corrupt manifest — restore manually`);
        }
        if (!manifest.service) {
            throw new Error(`Trash entry ${trashId} has no service name in manifest`);
        }

        const kubePath = manifest.originalKubePath || `~/${SYSTEMD_DIR}/${manifest.service}.kube`;
        const yamlPath = manifest.originalYamlPath
            ? (manifest.originalYamlPath.startsWith('/') ? manifest.originalYamlPath : `~/${manifest.originalYamlPath}`)
            : null;

        await agent.sendCommand('exec', {
            command: `mv '${trashDir}/${manifest.service}.kube' ${kubePath} 2>/dev/null || true`,
        });
        if (yamlPath) {
            // The yaml lives in the trash dir under its basename.
            const yamlBasename = manifest.originalYamlPath?.split('/').pop();
            if (yamlBasename) {
                await agent.sendCommand('exec', {
                    command: `mv '${trashDir}/${yamlBasename}' ${yamlPath} 2>/dev/null || true`,
                });
            }
        }
        // Wipe the now-empty trash dir.
        await agent.sendCommand('exec', { command: `rm -rf '${trashDir}'` });

        await this.reloadDaemon(nodeName);
        await this.refreshAgent(nodeName);
        this.backupQuadlets(nodeName);

        logger.info('ServiceManager', `Restored ${manifest.service} from trash on ${nodeName}`);
        return { service: manifest.service };
    }

    /** Permanently delete one trash entry, or all entries older than the
     *  given retention (in milliseconds). */
    static async purgeTrash(nodeName: string, opts: { trashId?: string; olderThanMs?: number }): Promise<{ purged: string[] }> {
        const agent = await agentManager.ensureAgent(nodeName);
        const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
        if (opts.trashId) {
            // Strict basename — no traversal allowed.
            if (!/^[a-zA-Z0-9._-]+$/.test(opts.trashId)) {
                throw new Error(`Invalid trash id: ${opts.trashId}`);
            }
            await agent.sendCommand('exec', { command: `rm -rf '${trashRoot}/${opts.trashId}'` });
            logger.info('ServiceManager', `Purged trash entry ${opts.trashId} on ${nodeName}`);
            return { purged: [opts.trashId] };
        }
        if (opts.olderThanMs !== undefined) {
            const list = await this.listTrashedServices(nodeName);
            const now = Date.now();
            const toPurge = list.filter(e => {
                const ts = Date.parse(e.deletedAt);
                if (!isFinite(ts)) return false;
                return (now - ts) > opts.olderThanMs!;
            });
            for (const entry of toPurge) {
                await agent.sendCommand('exec', { command: `rm -rf '${trashRoot}/${entry.id}'` });
            }
            if (toPurge.length > 0) {
                logger.info('ServiceManager', `Purged ${toPurge.length} trash entr${toPurge.length === 1 ? 'y' : 'ies'} older than ${Math.round(opts.olderThanMs / 86_400_000)}d on ${nodeName}`);
            }
            return { purged: toPurge.map(e => e.id) };
        }
        return { purged: [] };
    }

    static async getServiceLogs(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        let unit = serviceName;
        if (!unit.match(/\.(service|scope|socket|timer)$/)) {
            unit += '.service';
        }
        try {
            const res = await agent.sendCommand('exec', { command: `journalctl --user -u ${unit} -n 100 --no-pager` });
            return res.code === 0 ? res.stdout : '';
        } catch (e) {
            logger.warn('ServiceManager', 'Error fetching service logs:', e);
            return '';
        }
    }

    static async getPodmanLogs(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        try {
            const res = await agent.sendCommand('exec', { command: 'journalctl --user -t podman -n 100 --no-pager' });
            return res.code === 0 ? res.stdout : '';
        } catch (e) {
            logger.warn('ServiceManager', 'Error fetching podman logs:', e);
            return '';
        }
    }

    static async renameService(nodeName: string, oldName: string, newName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const oldKubePath = `~/${SYSTEMD_DIR}/${oldName}.kube`;
        const newKubePath = `~/${SYSTEMD_DIR}/${newName}.kube`;

        // Check if new service already exists
        const checkRes = await agent.sendCommand('exec', { command: `test -f ${newKubePath} && echo exists` });
        if (checkRes.stdout?.trim() === 'exists') {
            throw new Error(`Service ${newName} already exists`);
        }

        // Read old kube file
        const rawContent = await agent.sendCommand('read_file', { path: oldKubePath });
        const content = extractFileContent(rawContent);
        if (!content) throw new Error(`Could not read ${oldName}.kube`);

        const yamlMatch = content.match(/Yaml=(.+)/);
        const oldYamlFile = yamlMatch ? yamlMatch[1].trim() : null;
        if (!oldYamlFile) throw new Error('Could not determine YAML file from .kube file');

        const oldYamlPath = oldYamlFile.startsWith('/') ? oldYamlFile : `~/${SYSTEMD_DIR}/${oldYamlFile}`;
        const newYamlFile = `${newName}.yml`;
        const newYamlPath = `~/${SYSTEMD_DIR}/${newYamlFile}`;

        // 1. Stop old service
        try {
            await agent.sendCommand('exec', { command: `systemctl --user disable --now ${oldName}.service` });
        } catch (e) {
            logger.warn('ServiceManager', 'Failed to stop old service', e);
        }

        // 2. Rename YAML file
        const mvRes = await agent.sendCommand('exec', { command: `mv ${oldYamlPath} ${newYamlPath}` });
        if (mvRes.code !== 0) throw new Error(`Failed to rename YAML file: ${mvRes.stderr}`);

        // 3. Write new kube file with updated Yaml= reference, then remove old
        const newKubeContent = content.replace(/Yaml=.+/, `Yaml=${newYamlFile}`);
        await this.writeFile(nodeName, `${newName}.kube`, newKubeContent);
        await agent.sendCommand('exec', { command: `rm -f ${oldKubePath}` });

        // 4. Reload and start
        await this.reloadDaemon(nodeName);
        try {
            await agent.sendCommand('exec', { command: `systemctl --user enable --now ${newName}.service` });
        } catch (e) {
            throw new Error(`Failed to start new service: ${e}`);
        }

        await this.refreshAgent(nodeName);
        this.backupQuadlets(nodeName);
    }

     
    static async updateAndRestartService(nodeName: string, serviceName: string): Promise<{ logs: string[]; status: string }> {
        const agent = await agentManager.ensureAgent(nodeName);
        const { yamlPath } = await this.getServiceFiles(nodeName, serviceName);
        const logs: string[] = [];

        if (yamlPath) {
            try {
                const res = await agent.sendCommand('read_file', { path: yamlPath.startsWith('/') ? yamlPath : `~/${yamlPath}` });
                const content = extractFileContent(res);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const parsed = yaml.load(content) as any;

                const images = new Set<string>();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const findImages = (obj: any) => {
                    if (!obj) return;
                    if (obj.image && typeof obj.image === 'string') images.add(obj.image);
                    if (Array.isArray(obj.containers)) obj.containers.forEach((c: typeof obj) => findImages(c));
                    if (Array.isArray(obj.initContainers)) obj.initContainers.forEach((c: typeof obj) => findImages(c));
                    if (obj.spec) findImages(obj.spec);
                    if (obj.template) findImages(obj.template);
                };
                findImages(parsed);

                for (const image of images) {
                    logs.push(`Pulling image: ${image}`);
                    try {
                        await agent.pullImage(image, (evt) => {
                            if (evt.status && evt.id) {
                                const pct = evt.total ? ` ${Math.round((evt.current || 0) / evt.total * 100)}%` : '';
                                logs.push(`  ${evt.id}: ${evt.status}${pct}`);
                            }
                        });
                        logs.push(`Successfully pulled ${image}`);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        logs.push(`Failed to pull ${image}: ${msg}`);
                    }
                }
            } catch (e) {
                logger.warn('ServiceManager', 'Error parsing YAML for images', e);
                logs.push('Error parsing YAML to find images.');
            }
        } else {
            logs.push('No YAML file found for this service.');
        }

        logs.push('Reloading systemd daemon...');
        await this.reloadDaemon(nodeName);

        const unit = serviceName.endsWith('.service') ? serviceName : `${serviceName}.service`;
        logs.push(`Stopping service ${unit}...`);
        try { await agent.sendCommand('exec', { command: `systemctl --user --no-block stop ${unit}` }); } catch { /* ok */ }

        logs.push(`Starting service ${unit}...`);
        try {
            await agent.sendCommand('exec', { command: `systemctl --user --no-block start ${unit}` });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logs.push(`Error starting service: ${msg}`);
        }

        const status = await this.getServiceStatus(nodeName, serviceName);
        return { logs, status };
    }

    static async updateServiceDescription(nodeName: string, serviceName: string, description: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const kubePath = `~/${SYSTEMD_DIR}/${serviceName}.kube`;

        const raw = await agent.sendCommand('read_file', { path: kubePath });
        let content = extractFileContent(raw);
        const lines = content.split('\n');
        let unitIndex = -1;
        let descIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '[Unit]') {
                unitIndex = i;
            } else if (unitIndex !== -1 && line.startsWith('[') && line.endsWith(']')) {
                break;
            } else if (unitIndex !== -1 && line.startsWith('Description=')) {
                descIndex = i;
            }
        }

        if (unitIndex === -1) {
            content = `[Unit]\nDescription=${description}\n\n${content}`;
        } else if (descIndex !== -1) {
            lines[descIndex] = `Description=${description}`;
            content = lines.join('\n');
        } else {
            lines.splice(unitIndex + 1, 0, `Description=${description}`);
            content = lines.join('\n');
        }

        await this.writeFile(nodeName, `${serviceName}.kube`, content);
        await this.reloadDaemon(nodeName);
    }

    static async getServiceStatus(nodeName: string, serviceName: string): Promise<string> {
        const agent = await agentManager.ensureAgent(nodeName);
        const unit = serviceName.endsWith('.service') ? serviceName : `${serviceName}.service`;
        const res = await agent.sendCommand('exec', { command: `systemctl --user status ${unit} --no-pager -l` });
        // systemctl status returns non-zero for stopped/failed services, but output is still useful
        return res.stdout || res.stderr || '';
    }
}
