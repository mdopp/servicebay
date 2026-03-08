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

interface YamlResolution {
    /** Exact match for /etc/nginx/conf.d mount */
    exactConfDir: string | null;
    /** All hostPath mounts from the proxy pod, for probing */
    proxyHostPaths: { hostPath: string; containerDest: string }[];
}

/**
 * Known subdirectories where nginx configs live inside data volumes.
 * Nginx Proxy Manager stores per-host configs under /data/nginx/proxy_host/,
 * and custom configs under /data/nginx/custom/.
 */
const NPM_CONF_SUBDIRS = [
    'nginx/proxy_host',
    'nginx/custom',
    'nginx',
    'conf.d',
];

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

        // Try resolving from Digital Twin YAML
        const yamlResult = resolveFromTwinYaml(twinStore, nodeName, debug);
        if (yamlResult.exactConfDir) {
            logger.info('NginxConfDir', `Resolved conf.d from YAML: ${yamlResult.exactConfDir} on ${nodeName}`);
            return { nodeName, confDir: yamlResult.exactConfDir, debug };
        }

        // Probe proxy volume host paths for known nginx config subdirectories
        if (yamlResult.proxyHostPaths.length > 0) {
            debug.push(`Node "${nodeName}": no exact conf.d mount, probing ${yamlResult.proxyHostPaths.length} proxy volume(s)`);
            const probed = await probeProxyVolumes(nodeName, yamlResult.proxyHostPaths, debug);
            if (probed) {
                logger.info('NginxConfDir', `Resolved conf.d via volume probe: ${probed} on ${nodeName}`);
                return { nodeName, confDir: probed, debug };
            }
        }

        // Fallback: probe common filesystem paths
        debug.push(`Node "${nodeName}": probing common system paths`);
        const probed = await probeCommonPaths(nodeName, debug);
        if (probed) {
            logger.info('NginxConfDir', `Resolved conf.d via system probe: ${probed} on ${nodeName}`);
            return { nodeName, confDir: probed, debug };
        }

        const isNative = yamlResult.proxyHostPaths.length === 0;
        const reason = `Found nginx service "${nginxService.name}" on "${nodeName}" but could not locate the conf.d directory. `
            + (isNative
                ? 'This appears to be a native (non-containerized) nginx install. '
                  + `The standard paths (${COMMON_CONF_DIRS.join(', ')}) could not be read — `
                  + 'make sure nginx is fully installed and the conf.d directory exists.'
                : 'No /etc/nginx/conf.d volume mount was found in the service YAML, '
                  + 'and probing proxy data volumes and common system paths found no .conf files.');
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
): YamlResolution {
    const result: YamlResolution = { exactConfDir: null, proxyHostPaths: [] };
    const twin = twinStore.nodes[nodeName];
    if (!twin?.files) {
        debug.push(`Node "${nodeName}": no files in twin store`);
        return result;
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

                    // Exact match — traditional nginx with conf.d bind mount
                    if (containerDest === '/etc/nginx/conf.d') {
                        debug.push(`  MATCH: volume "${volName}" → hostPath "${hp.path}"`);
                        result.exactConfDir = hp.path;
                        return result;
                    }

                    // Collect all proxy hostPaths for probing (NPM, custom setups)
                    result.proxyHostPaths.push({ hostPath: hp.path, containerDest });
                }
            }
        } catch (e) {
            debug.push(`  ${filePath}: YAML parse error: ${e}`);
        }
    }

    debug.push(`Node "${nodeName}": no exact conf.d mount in YAML, found ${result.proxyHostPaths.length} proxy volume(s)`);
    return result;
}

async function probeProxyVolumes(
    nodeName: string,
    hostPaths: { hostPath: string; containerDest: string }[],
    debug: string[],
): Promise<string | null> {
    const executor = getExecutor(nodeName);
    for (const { hostPath, containerDest } of hostPaths) {
        debug.push(`  Probing proxy volume: hostPath="${hostPath}" (mounted at ${containerDest})`);
        for (const sub of NPM_CONF_SUBDIRS) {
            const candidate = `${hostPath}/${sub}`;
            try {
                const files = await executor.readdir(candidate);
                const confFiles = files.filter(f => f.endsWith('.conf'));
                debug.push(`    ${candidate}: ${files.length} file(s), ${confFiles.length} .conf`);
                if (confFiles.length > 0) return candidate;
            } catch {
                debug.push(`    ${candidate}: not accessible`);
            }
        }
    }
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
            // Directory might exist but agent lacks read permission (native nginx).
            // Check existence separately — the export route reads via the executor
            // which may succeed with different permissions or sudo.
            try {
                const exists = await executor.exists(dir);
                if (exists) {
                    debug.push(`  Probe ${dir}: exists but cannot list contents (permission issue), using it`);
                    return dir;
                }
            } catch { /* ignore */ }
            debug.push(`  Probe ${dir}: not accessible`);
        }
    }
    return null;
}
