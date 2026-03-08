import { agentManager } from '../agent/manager';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../logger';
import { getConfig } from '../config';

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
                                     // Check role labels
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
    static async startService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user start ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async stopService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user stop ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async restartService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
         const res = await agent.sendCommand('exec', { command: `systemctl --user restart ${serviceName}.service` });
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

    static async deployKubeService(nodeName: string, name: string, kubeContent: string, yamlContent: string, yamlName: string) {
        // Ensure TimeoutStartSec for multi-image pods so image pulls don't cause systemd timeout
        const images = this.extractImages(yamlContent);
        if (images.length > 1 && !kubeContent.includes('TimeoutStartSec')) {
            kubeContent = this.injectServiceTimeout(kubeContent);
        }

        await this.writeFile(nodeName, yamlName, yamlContent);
        await this.writeFile(nodeName, `${name}.kube`, kubeContent);
        await this.ensurePodmanSocket(nodeName);

        // Ensure unprivileged port binding if any port < 1024 is used
        if (this.hasPrivilegedPorts(yamlContent)) {
            await this.ensureUnprivilegedPorts(nodeName);
        }

        await this.reloadDaemon(nodeName);

        // Pre-pull all images before starting to avoid systemd timeout
        await this.prePullImages(nodeName, images);

        // Fix volume ownership for containers running as non-root UIDs
        await this.fixVolumeOwnership(nodeName, yamlContent);

        // Attempt start, but don't fail deployment if start fails (user can check logs)
        try {
             await this.startService(nodeName, name);
        } catch(e) {
             logger.warn('ServiceManager', `Service ${name} deployed but start failed:`, e);
        }
        this.backupQuadlets(nodeName);
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

    /** Inject [Service] TimeoutStartSec into .kube content if not present */
    private static injectServiceTimeout(kubeContent: string, timeout = 600): string {
        if (kubeContent.includes('[Service]')) {
            return kubeContent.replace('[Service]', `[Service]\nTimeoutStartSec=${timeout}`);
        }
        return kubeContent + `\n[Service]\nTimeoutStartSec=${timeout}\n`;
    }

    /** Pre-pull container images so systemd start doesn't timeout */
    private static async prePullImages(nodeName: string, images: string[]) {
        const agent = await agentManager.ensureAgent(nodeName);
        for (const image of images) {
            try {
                logger.info('ServiceManager', `Pre-pulling image: ${image}`);
                await agent.sendCommand('exec', { command: `podman pull ${image}`, timeout: 300 });
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
}
