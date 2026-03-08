import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { getExecutor } from '@/lib/executor';
import { parseQuadletFile } from '@/lib/quadlet/parser';
import { getConfig } from '@/lib/config';
import yaml from 'js-yaml';
import path from 'path';
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
    /** True when the proxy uses Nginx Proxy Manager (data lives under /data) */
    isNpm: boolean;
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
            (s.name.includes('nginx') && !s.name.startsWith('install-')) ||
            (s.description?.toLowerCase().includes('nginx') && !s.name.startsWith('install-'))
        );
        if (!nginxService) {
            debug.push(`Node "${nodeName}": no nginx service`);
            continue;
        }
        debug.push(`Node "${nodeName}": found nginx service "${nginxService.name}"`);

        // Try resolving from Digital Twin YAML
        const yamlResult = resolveFromTwinFiles(twinStore, nodeName, debug);

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

        // NPM fallback: if we detected Nginx Proxy Manager but YAML volume extraction
        // failed (e.g. named volumes without hostPath), construct the data path from
        // template settings DATA_DIR and probe NPM's known config subdirectories.
        if (yamlResult.isNpm && yamlResult.proxyHostPaths.length === 0) {
            debug.push(`Node "${nodeName}": NPM detected but no hostPath volumes extracted, trying DATA_DIR fallback`);
            const npmPaths = await buildNpmFallbackPaths(debug);
            if (npmPaths.length > 0) {
                const probed = await probeProxyVolumes(nodeName, npmPaths, debug);
                if (probed) {
                    logger.info('NginxConfDir', `Resolved conf.d via NPM DATA_DIR fallback: ${probed} on ${nodeName}`);
                    return { nodeName, confDir: probed, debug };
                }
            }
        }

        // Fallback: probe common filesystem paths
        debug.push(`Node "${nodeName}": probing common system paths`);
        const probed = await probeCommonPaths(nodeName, debug);
        if (probed) {
            logger.info('NginxConfDir', `Resolved conf.d via system probe: ${probed} on ${nodeName}`);
            return { nodeName, confDir: probed, debug };
        }

        const hasVolumes = yamlResult.proxyHostPaths.length > 0 || yamlResult.isNpm;
        const reason = `Found nginx service "${nginxService.name}" on "${nodeName}" but could not locate the nginx config directory. `
            + (hasVolumes
                ? 'Probed proxy data volumes and common system paths but found no .conf files. '
                  + 'Make sure the service has started at least once so the config directories are created.'
                : 'This appears to be a native (non-containerized) nginx install. '
                  + `The standard paths (${COMMON_CONF_DIRS.join(', ')}) could not be read — `
                  + 'make sure nginx is fully installed and the conf.d directory exists.');
        debug.push(reason);
        return { nodeName, confDir: '', reason, debug };
    }

    const reason = 'No nginx service was found on any node. '
        + 'Make sure you have an nginx service deployed and visible in the Services page.';
    debug.push(reason);
    return { nodeName: nodeNames[0] || 'Local', confDir: '', reason, debug };
}

function resolveFromTwinFiles(
    twinStore: DigitalTwinStore,
    nodeName: string,
    debug: string[],
): YamlResolution {
    const result: YamlResolution = { exactConfDir: null, proxyHostPaths: [], isNpm: false };
    const twin = twinStore.nodes[nodeName];
    if (!twin?.files) {
        debug.push(`Node "${nodeName}": no files in twin store`);
        return result;
    }

    const proxyState = twinStore.proxy;
    const fileKeys = Object.keys(twin.files);
    const yamlFiles = fileKeys.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    const kubeFiles = fileKeys.filter(f => f.endsWith('.kube'));
    const containerFiles = fileKeys.filter(f => f.endsWith('.container'));
    debug.push(`Node "${nodeName}": ${fileKeys.length} files in twin (${yamlFiles.length} YAML, ${kubeFiles.length} .kube, ${containerFiles.length} .container)`);

    // 1. Try direct kube YAML files (Pod manifests with volumes)
    for (const filePath of yamlFiles) {
        const found = resolveFromKubeYaml(twin.files[filePath]?.content, filePath, proxyState, result, debug);
        if (found) return result;
    }

    // 2. Try .kube quadlet files — they reference a Yaml= file
    for (const filePath of kubeFiles) {
        const file = twin.files[filePath];
        if (!file?.content) continue;
        const directives = parseQuadletFile(file.content);
        if (!directives.kubeYaml) {
            debug.push(`  ${filePath}: .kube file without Yaml= directive`);
            continue;
        }
        // Resolve the referenced YAML relative to the .kube file's directory
        const yamlRef = directives.kubeYaml;
        const dir = path.dirname(filePath);
        const candidates = [
            path.resolve(dir, yamlRef),   // relative to .kube file
            ...fileKeys.filter(k => k.endsWith('/' + yamlRef) || k === yamlRef) // exact match in twin
        ];
        let resolved = false;
        for (const candidate of candidates) {
            const refFile = twin.files[candidate];
            if (refFile?.content) {
                debug.push(`  ${filePath}: Yaml=${yamlRef} → ${candidate}`);
                const found = resolveFromKubeYaml(refFile.content, candidate, proxyState, result, debug);
                if (found) return result;
                resolved = true;
                break;
            }
        }
        if (!resolved) {
            debug.push(`  ${filePath}: Yaml=${yamlRef} not found in twin store`);
        }
    }

    // 3. Try .container quadlet files — they have Volume= directives
    for (const filePath of containerFiles) {
        const file = twin.files[filePath];
        if (!file?.content) continue;
        const directives = parseQuadletFile(file.content);
        const name = directives.containerName || path.basename(filePath, '.container');
        const isProxy = /nginx|proxy/i.test(name)
            || (proxyState?.provider === 'nginx' && /nginx/i.test(name));
        if (!isProxy) {
            debug.push(`  ${filePath}: container "${name}" is not a proxy`);
            continue;
        }
        debug.push(`  ${filePath}: container "${name}" identified as proxy`);

        if (!directives.volumes?.length) {
            debug.push(`  ${filePath}: no Volume= directives`);
            continue;
        }

        for (const vol of directives.volumes) {
            // Volume= format: hostPath:containerPath[:opts]
            const parts = vol.split(':');
            if (parts.length < 2) continue;
            const hostPath = parts[0];
            const containerDest = parts[1];

            if (containerDest === '/etc/nginx/conf.d') {
                debug.push(`  MATCH: Volume "${vol}" → hostPath "${hostPath}"`);
                result.exactConfDir = hostPath;
                return result;
            }
            result.proxyHostPaths.push({ hostPath, containerDest });
        }
    }

    debug.push(`Node "${nodeName}": no exact conf.d mount found, ${result.proxyHostPaths.length} proxy volume(s) collected`);
    return result;
}

/** Parse a kube YAML (Pod manifest) looking for proxy volumes */
function resolveFromKubeYaml(
    content: string | undefined,
    filePath: string,
    proxyState: { provider: string; routes: unknown[] },
    result: YamlResolution,
    debug: string[],
): boolean {
    if (!content) {
        debug.push(`  ${filePath}: no content`);
        return false;
    }

    try {
        const docs = yaml.loadAll(content) as Record<string, unknown>[];
        for (const doc of docs) {
            if (!doc?.spec) continue;
            const spec = doc.spec as Record<string, unknown>;
            const meta = doc.metadata as Record<string, unknown> | undefined;
            const labels = (meta?.labels || {}) as Record<string, string>;
            const podName = (meta?.name || '') as string;

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
                const ctName = (ct.name || '') as string;
                const ctImage = (ct.image || '') as string;
                // Detect Nginx Proxy Manager by container name or image
                if (/nginx-proxy-manager|jc21\/nginx-proxy-manager/i.test(`${ctName} ${ctImage}`)) {
                    result.isNpm = true;
                }
                for (const vm of (ct.volumeMounts || []) as Array<Record<string, string>>) {
                    if (vm.name && vm.mountPath) mountMap.set(vm.name, vm.mountPath);
                }
            }

            debug.push(`  ${filePath}: ${volumes.length} volumes, mounts: ${JSON.stringify(Object.fromEntries(mountMap))}`);

            for (const vol of volumes) {
                const hp = vol.hostPath as Record<string, string> | undefined;
                const volName = vol.name as string;
                if (!hp?.path) {
                    debug.push(`  ${filePath}: volume "${volName}" has no hostPath.path (keys: ${hp ? Object.keys(hp).join(',') : 'no hostPath'})`);
                    continue;
                }
                const containerDest = mountMap.get(volName) || '';

                if (containerDest === '/etc/nginx/conf.d') {
                    debug.push(`  MATCH: volume "${volName}" → hostPath "${hp.path}"`);
                    result.exactConfDir = hp.path;
                    return true;
                }

                result.proxyHostPaths.push({ hostPath: hp.path, containerDest });
            }
        }
    } catch (e) {
        debug.push(`  ${filePath}: YAML parse error: ${e}`);
    }
    return false;
}

/**
 * Build fallback probe paths for NPM from template settings DATA_DIR.
 * NPM's data volume is typically at DATA_DIR/nginx-proxy-manager/data.
 */
async function buildNpmFallbackPaths(debug: string[]): Promise<{ hostPath: string; containerDest: string }[]> {
    const paths: { hostPath: string; containerDest: string }[] = [];
    try {
        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR;
        if (dataDir) {
            const npmDataPath = `${dataDir}/nginx-proxy-manager/data`;
            debug.push(`  DATA_DIR from settings: "${dataDir}" → probing ${npmDataPath}`);
            paths.push({ hostPath: npmDataPath, containerDest: '/data' });
        } else {
            debug.push('  No DATA_DIR in template settings');
        }
    } catch {
        debug.push('  Could not read config for DATA_DIR');
    }
    // Also try the common default
    if (paths.length === 0) {
        const defaultPath = '/mnt/data/nginx-proxy-manager/data';
        debug.push(`  Trying default NPM data path: ${defaultPath}`);
        paths.push({ hostPath: defaultPath, containerDest: '/data' });
    }
    return paths;
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
