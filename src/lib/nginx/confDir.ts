import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { getExecutor } from '@/lib/executor';
import yaml from 'js-yaml';
import { logger } from '@/lib/logger';

export interface NginxConfDirResult {
    nodeName: string;
    confDir: string;
    debug: string[];
    /** Human-readable reason when confDir is empty */
    reason?: string;
}

/** Common conf.d locations to try as fallback */
const COMMON_CONF_DIRS = [
    '/etc/nginx/conf.d',
    '/usr/local/nginx/conf/conf.d',
];

/**
 * Find the nginx node and the conf.d host path by parsing the Digital Twin's
 * stored YAML — same source of truth as the backup system (systemBackup.ts).
 * Falls back to probing common filesystem paths if YAML resolution fails.
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

        // Try resolving from Digital Twin YAML first
        const yamlResult = resolveFromTwinYaml(twinStore, nodeName, debug);
        if (yamlResult) {
            logger.info('NginxConfDir', `Resolved conf.d from YAML: ${yamlResult} on ${nodeName}`);
            return { nodeName, confDir: yamlResult, debug };
        }

        // Fallback: probe common filesystem paths
        debug.push(`Node "${nodeName}": YAML resolution failed, probing common paths`);
        const probed = await probeCommonPaths(nodeName, debug);
        if (probed) {
            logger.info('NginxConfDir', `Resolved conf.d via probe: ${probed} on ${nodeName}`);
            return { nodeName, confDir: probed, debug };
        }

        const reason = `Found nginx service "${nginxService.name}" on "${nodeName}" but could not locate the conf.d directory. `
            + 'The nginx container volume mapping for /etc/nginx/conf.d was not found in the service YAML, '
            + `and none of the common paths (${COMMON_CONF_DIRS.join(', ')}) are accessible on the host.`;
        debug.push(reason);
        return { nodeName, confDir: '', reason, debug };
    }

    const reason = 'No nginx service was found on any node. '
        + 'Make sure you have an nginx service deployed and visible in the Services page.';
    debug.push(reason);
    return { nodeName: nodeNames[0] || 'Local', confDir: '', reason, debug };
}

function resolveFromTwinYaml(
    twinStore: DigitalTwinStore,
    nodeName: string,
    debug: string[],
): string | null {
    const twin = twinStore.nodes[nodeName];
    if (!twin?.files) {
        debug.push(`Node "${nodeName}": no files in twin store`);
        return null;
    }

    const proxyState = twinStore.proxy;
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

                // Match backup logic: also check proxyState.provider
                const isProxy = labels['servicebay.role'] === 'reverse-proxy'
                    || /nginx|proxy/i.test(podName)
                    || (proxyState?.provider === 'nginx' && /nginx/i.test(podName));
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
                        return hp.path;
                    }
                }
            }
        } catch (e) {
            debug.push(`  ${filePath}: YAML parse error: ${e}`);
        }
    }

    debug.push(`Node "${nodeName}": conf.d path not found in any YAML file`);
    return null;
}

async function probeCommonPaths(nodeName: string, debug: string[]): Promise<string | null> {
    const executor = getExecutor(nodeName);
    for (const dir of COMMON_CONF_DIRS) {
        try {
            const files = await executor.readdir(dir);
            debug.push(`  Probe ${dir}: found ${files.length} file(s)`);
            if (files.length > 0) return dir;
        } catch {
            debug.push(`  Probe ${dir}: not accessible`);
        }
    }
    return null;
}
