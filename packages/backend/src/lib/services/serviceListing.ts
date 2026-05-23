/**
 * Service listing / read operations (#589 follow-up).
 *
 * Extracted from the monolithic ServiceManager.ts. Contains every
 * read-only operation: listServices (the orchestration tying the
 * container-name matcher + YAML extractor + twin together), the
 * file/log readers, the host-port-collision pre-flight, and the
 * status query.
 */

import path from 'path';
import { agentManager } from '../agent/manager';
import { logger } from '../logger';
import yaml from 'js-yaml';
import { buildExpectedContainerNames, pickContainerForService, type PodLikeDoc } from './containerNameMatcher';
import { parseQuadletYaml } from './yamlExtractor';

const SYSTEMD_DIR = '.config/containers/systemd';

/** Extract string content from agent read_file response. */
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

/**
 * Quadlet files that are part of ServiceBay's own runtime but aren't
 * services the operator manages. Excluded from `listServices` so they
 * never appear in the dashboard's services count / list.
 *
 * - `servicebay-splash` is the boot-time placeholder (#775) that binds
 *   :5888 during cold boot so visitors see "starting up" instead of a
 *   connection-refused page. It's a one-shot — its success state is
 *   `inactive (dead)` once the real servicebay.service takes over via
 *   the `Conflicts=` directive. Showing it as "1 of 14 not running"
 *   on the dashboard is misleading, since the operator can't fix it
 *   (nor should they — it's working as designed).
 */
const HIDDEN_SERVICE_BASENAMES = new Set<string>([
  'servicebay-splash',
]);

export class ServiceListing {
    static async listServices(nodeName: string): Promise<ServiceInfo[]> {
        // V4: Use DigitalTwinStore
        const { getNodeTwin, getProxyState } = await import('../store/repository');
        const twin = getNodeTwin(nodeName);
        const proxyState = getProxyState(); // Access Global Proxy State

        if (!twin) return [];

        const services: ServiceInfo[] = [];

        for (const [filePath, file] of Object.entries(twin.files)) {
            // Only process .kube and .container
            if (!filePath.endsWith('.kube') && !filePath.endsWith('.container')) continue;
            
            const fileName = path.basename(filePath);
            const baseName = filePath.endsWith('.kube') ? fileName.replace('.kube', '') : fileName.replace('.container', '');
            const type = filePath.endsWith('.kube') ? 'kube' : 'container';

            // Skip ServiceBay-internal Quadlets the operator doesn't manage
            // (boot splash, etc. — see HIDDEN_SERVICE_BASENAMES comment).
            if (HIDDEN_SERVICE_BASENAMES.has(baseName)) continue;

            // Find State
            const unitName = `${baseName}.service`;
            // Relaxed matching for service unit (strip .service to compare with baseName)
            const serviceUnit = twin.services.find(s => s.name === unitName || s.name === baseName);
            
            // Container-name matching lifted into containerNameMatcher.ts +
            // yamlExtractor.ts (#589). The matcher generates every plausible
            // candidate name (simple / systemd-prefixed / pod-prefixed /
            // YAML-derived) and the extractor handles the parse cache.
            let yamlContent: string | null = null;
            let yamlPath: string | null = null;
            let yamlFile: string | null = null;
            let podDocs: PodLikeDoc[] = [];

            if (type === 'kube' && file.content) {
                const match = file.content.match(/^Yaml=(.+)$/m);
                if (match) {
                    yamlFile = match[1].trim();
                    yamlPath = path.join(path.dirname(filePath), yamlFile);
                    yamlContent = twin.files[yamlPath]?.content ?? null;
                    if (!yamlContent) {
                        const foundPath = Object.keys(twin.files).find(p => p.endsWith(yamlFile!));
                        if (foundPath) yamlContent = twin.files[foundPath].content;
                    }
                    if (yamlContent) {
                        podDocs = parseQuadletYaml(yamlContent, `${nodeName}:${yamlPath}`);
                    }
                }
            }

            const uniqueExpected = buildExpectedContainerNames(baseName, podDocs);
            const container = pickContainerForService(twin.containers, uniqueExpected);
            const candidates = container ? [container] : [];

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
            // (We re-use yamlContent from above if parsed). The earlier
            // matcher block already populated podDocs via parseQuadletYaml
            // — re-use it instead of re-parsing.
            if (type === 'kube' && yamlContent) {
                     if (yamlContent) {
                         try {
                              const docs = podDocs;
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
                                     // Pin `spec` to a local so TS narrows it through the
                                     // forEach callbacks below — without this the typed
                                     // PodLikeDoc shape (introduced in #589) trips a
                                     // "possibly undefined" check the older `any` cast
                                     // suppressed.
                                     const spec = doc.spec;
                                     // Host Network
                                     if (spec.hostNetwork) info.hostNetwork = true;

                                     // Ports (Fallback if container not providing them)
                                     if (spec.containers && info.ports.length === 0) {
                                         spec.containers.forEach(c => {
                                             if (c.ports) {
                                                 c.ports.forEach(p => {
                                                     let host = p.hostPort ? String(p.hostPort) : undefined;
                                                     const container = String(p.containerPort);

                                                     // If Host Network, container port IS host port
                                                     if (!host && (info.hostNetwork || spec.hostNetwork)) {
                                                         host = container;
                                                     }

                                                     info.ports.push({ host, container });
                                                 });
                                             }

                                             // Volumes (Kube)
                                             if (c.volumeMounts && spec.volumes) {
                                                c.volumeMounts.forEach(m => {
                                                    const volDef = spec.volumes!.find(v => v.name === m.name);
                                                    let host = '';
                                                    if (volDef) {
                                                        if (volDef.hostPath?.path) host = volDef.hostPath.path;
                                                        else if (volDef.persistentVolumeClaim?.claimName) host = `pvc:${volDef.persistentVolumeClaim.claimName}`;
                                                        else host = 'volume:' + m.name;
                                                    }
                                                    info.volumes.push({ host: host, container: m.mountPath ?? '' });
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
            // Skip ServiceBay-internal helpers (boot splash, etc.) here too —
            // they're flagged isServiceBay by the twin detector because the
            // unit name contains "servicebay", but they're not user-managed
            // and shouldn't show up in the dashboard's services count.
            && !HIDDEN_SERVICE_BASENAMES.has(s.name)
            && !HIDDEN_SERVICE_BASENAMES.has(s.name.replace(/\.service$/, ''))
        );

        for (const serviceUnit of specialServices) {
            const baseName = serviceUnit.name; // e.g. nginx (agent strips .service)
            // Determine expected container names for these system services
            const expectedNames = [baseName];
            
            // Special aliases
            if (serviceUnit.isReverseProxy) {
                expectedNames.push(baseName);
                expectedNames.push('nginx');
                expectedNames.push('nginx');
                expectedNames.push('systemd-nginx');
                expectedNames.push('systemd-nginx');
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

            const isProxy = serviceUnit?.isReverseProxy ?? (proxyState?.provider === 'nginx' && (baseName === 'nginx' || baseName === 'nginx'));
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
        const wanted = ServiceListing.extractHostPorts(yamlContent);
        if (wanted.length === 0) return [];
        const services = await ServiceListing.listServices(nodeName);
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
    static extractImages(yamlContent: string): string[] {
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
    static hasPrivilegedPorts(yamlContent: string): boolean {
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
            const { getNodeTwin } = await import('../store/repository');
            const twin = getNodeTwin(nodeName);

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

    static async getServiceStatus(nodeName: string, serviceName: string): Promise<string> {
        const agent = await agentManager.ensureAgent(nodeName);
        const unit = serviceName.endsWith('.service') ? serviceName : `${serviceName}.service`;
        const res = await agent.sendCommand('exec', { command: `systemctl --user status ${unit} --no-pager -l` });
        // systemctl status returns non-zero for stopped/failed services, but output is still useful
        return res.stdout || res.stderr || '';
    }
}
