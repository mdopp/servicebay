import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import yaml from 'js-yaml';
import { logger } from '@/lib/logger';

export interface NginxConfDirResult {
    nodeName: string;
    confDir: string;
    debug: string[];
}

/**
 * Find the nginx node and the conf.d host path by parsing the Digital Twin's
 * stored YAML — same source of truth as the backup system (systemBackup.ts).
 */
export async function findNginxConfDir(): Promise<NginxConfDirResult | null> {
    const debug: string[] = [];
    const twinStore = DigitalTwinStore.getInstance();
    const nodeNames = Object.keys(twinStore.nodes);
    if (nodeNames.length === 0) {
        nodeNames.push('Local');
        debug.push('No nodes in twin store, falling back to Local');
    } else {
        debug.push(`Twin store nodes: ${nodeNames.join(', ')}`);
    }

    for (const nodeName of nodeNames) {
        const services = await ServiceManager.listServices(nodeName);
        debug.push(`Node "${nodeName}": ${services.length} services found`);

        const nginxService = services.find(s =>
            s.name === 'nginx-web' ||
            s.name.includes('nginx') ||
            s.description?.toLowerCase().includes('nginx')
        );
        if (!nginxService) {
            debug.push(`Node "${nodeName}": no nginx service`);
            continue;
        }
        debug.push(`Node "${nodeName}": found nginx service "${nginxService.name}"`);

        const twin = twinStore.nodes[nodeName];
        if (!twin?.files) {
            debug.push(`Node "${nodeName}": no files in twin store`);
            return { nodeName, confDir: '', debug };
        }

        const fileKeys = Object.keys(twin.files);
        const yamlFiles = fileKeys.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
        debug.push(`Node "${nodeName}": ${fileKeys.length} files in twin, ${yamlFiles.length} YAML files`);

        for (const filePath of yamlFiles) {
            const file = twin.files[filePath];
            if (!file.content) {
                debug.push(`  ${filePath}: no content`);
                continue;
            }

            try {
                const docs = yaml.loadAll(file.content) as Record<string, unknown>[];
                for (const doc of docs) {
                    if (!doc?.spec) continue;
                    const spec = doc.spec as Record<string, unknown>;
                    const meta = doc.metadata as Record<string, unknown> | undefined;
                    const labels = (meta?.labels || {}) as Record<string, string>;
                    const podName = (meta?.name || '') as string;

                    const isProxy = labels['servicebay.role'] === 'reverse-proxy'
                        || /nginx|proxy/i.test(podName);
                    if (!isProxy) {
                        debug.push(`  ${filePath}: pod "${podName}" is not a proxy`);
                        continue;
                    }
                    debug.push(`  ${filePath}: pod "${podName}" identified as proxy`);

                    const volumes = (spec.volumes || []) as Array<Record<string, unknown>>;
                    const containers = (spec.containers || []) as Array<Record<string, unknown>>;
                    const mountMap = new Map<string, string>();
                    for (const ct of containers) {
                        for (const vm of (ct.volumeMounts || []) as Array<Record<string, string>>) {
                            if (vm.name && vm.mountPath) mountMap.set(vm.name, vm.mountPath);
                        }
                    }

                    debug.push(`  ${filePath}: ${volumes.length} volumes, mounts: ${JSON.stringify(Object.fromEntries(mountMap))}`);

                    for (const vol of volumes) {
                        const hp = vol.hostPath as Record<string, string> | undefined;
                        if (!hp?.path) continue;
                        const volName = vol.name as string;
                        const containerDest = mountMap.get(volName) || '';
                        if (containerDest === '/etc/nginx/conf.d') {
                            debug.push(`  MATCH: volume "${volName}" → hostPath "${hp.path}"`);
                            logger.info('NginxConfDir', `Resolved conf.d: ${hp.path} on ${nodeName}`);
                            return { nodeName, confDir: hp.path, debug };
                        }
                    }
                }
            } catch (e) {
                debug.push(`  ${filePath}: YAML parse error: ${e}`);
            }
        }

        debug.push(`Node "${nodeName}": nginx service found but conf.d path not resolved from YAML`);
        return { nodeName, confDir: '', debug };
    }

    debug.push('No nginx service found on any node');
    return null;
}
