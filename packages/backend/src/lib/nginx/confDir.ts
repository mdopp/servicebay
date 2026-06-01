import { ServiceManager } from '@/lib/services/ServiceManager';
import { getNodeIds, getNodeTwin, getProxyState } from '@/lib/store/repository';
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

/**
 * Find the nginx node and the conf.d host path by parsing the Digital Twin's
 * stored YAML — same source of truth as the backup system (systemBackup.ts).
 */
export async function findNginxConfDir(): Promise<NginxConfDirResult | null> {
    const debug: string[] = [];
    const nodeNames = getNodeIds();
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
            s.name === 'nginx' ||
            (s.name.includes('nginx') && !s.name.startsWith('install-')) ||
            (s.description?.toLowerCase().includes('nginx') && !s.name.startsWith('install-'))
        );
        if (!nginxService) {
            debug.push(`Node "${nodeName}": no nginx service`);
            continue;
        }
        debug.push(`Node "${nodeName}": found nginx service "${nginxService.name}"`);

        // Try resolving from Digital Twin YAML
        const confDir = await probeNginxConfFromTwin(nodeName, debug);
        if (confDir) {
            logger.info('NginxConfDir', `Resolved conf.d from YAML: ${confDir} on ${nodeName}`);
            return { nodeName, confDir, debug };
        }

        const reason = `Found nginx service "${nginxService.name}" on "${nodeName}" but could not locate the nginx config directory. `
            + 'Probed proxy data volumes but found no .conf files. '
            + 'Make sure the service has started at least once so the config directories are created.';
        debug.push(reason);
        return { nodeName, confDir: '', reason, debug };
    }

    const reason = 'No nginx service was found on any node. '
        + 'Make sure you have an nginx service deployed and visible in the Services page.';
    debug.push(reason);
    return { nodeName: nodeNames[0] || 'Local', confDir: '', reason, debug };
}


/**
 * Probe .kube quadlet files for referenced YAML files that define proxy volumes.
 * Extracted from probeNginxConfFromTwin.
 */
async function probeKubeQuadletFiles(
    kubeFiles: string[],
    fileKeys: string[],
    twinFiles: Record<string, { content?: string }>,
    proxyState: { provider: string; routes: unknown[] },
    debug: string[],
): Promise<string | null> {
    for (const filePath of kubeFiles) {
        const file = twinFiles[filePath];
        if (!file?.content) continue;
        const directives = parseQuadletFile(file.content);
        if (!directives.kubeYaml) {
            debug.push(`  ${filePath}: .kube file without Yaml= directive`);
            continue;
        }
        const yamlRef = directives.kubeYaml;
        const dir = path.dirname(filePath);
        const candidates = [
            path.resolve(dir, yamlRef),
            ...fileKeys.filter(k => k.endsWith('/' + yamlRef) || k === yamlRef)
        ];
        for (const candidate of candidates) {
            const refFile = twinFiles[candidate];
            if (refFile?.content) {
                debug.push(`  ${filePath}: Yaml=${yamlRef} → ${candidate}`);
                const confDir = await probeNginxConfFromKube(refFile.content, candidate, proxyState, debug);
                if (confDir) return confDir;
                break;
            }
        }
    }
    return null;
}

/**
 * Probe .container quadlet files for nginx Volume= directives.
 * Extracted from probeNginxConfFromTwin.
 */
function probeContainerQuadletFiles(
    containerFiles: string[],
    twinFiles: Record<string, { content?: string }>,
    proxyState: { provider: string; routes: unknown[] },
    debug: string[],
): string | null {
    for (const filePath of containerFiles) {
        const file = twinFiles[filePath];
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
            const parts = vol.split(':');
            if (parts.length < 2) continue;
            const hostPath = parts[0];
            const containerDest = parts[1];

            if (containerDest === '/etc/nginx/conf.d') {
                debug.push(`  MATCH: Volume "${vol}" → hostPath "${hostPath}"`);
                return hostPath;
            }
        }
    }
    return null;
}

/**
 * Probe the twin store's YAML/kube/container files for nginx conf.d mount points.
 * Tries (1) direct YAML files, (2) .kube quadlet references, (3) .container
 * quadlet directives. Returns the exact conf.d path on match, or falls back to
 * probing known NPM subdirectories.
 */
async function probeNginxConfFromTwin(
    nodeName: string,
    debug: string[],
): Promise<string | null> {
    const twin = getNodeTwin(nodeName);
    if (!twin?.files) {
        debug.push(`Node "${nodeName}": no files in twin store`);
        return null;
    }

    const proxyState = getProxyState();
    const fileKeys = Object.keys(twin.files);
    const yamlFiles = fileKeys.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    const kubeFiles = fileKeys.filter(f => f.endsWith('.kube'));
    const containerFiles = fileKeys.filter(f => f.endsWith('.container'));
    debug.push(`Node "${nodeName}": ${fileKeys.length} files in twin (${yamlFiles.length} YAML, ${kubeFiles.length} .kube, ${containerFiles.length} .container)`);

    // 1. Try direct kube YAML files (Pod manifests with volumes)
    for (const filePath of yamlFiles) {
        const confDir = await probeNginxConfFromKube(twin.files[filePath]?.content, filePath, proxyState, debug);
        if (confDir) return confDir;
    }

    // 2. Try .kube quadlet files — they reference a Yaml= file
    const kubeResult = await probeKubeQuadletFiles(kubeFiles, fileKeys, twin.files, proxyState, debug);
    if (kubeResult) return kubeResult;

    // 3. Try .container quadlet files — they have Volume= directives
    const containerResult = probeContainerQuadletFiles(containerFiles, twin.files, proxyState, debug);
    if (containerResult) return containerResult;

    // Fallback: probe known NPM subdirectories under DATA_DIR
    const isNpm = fileKeys.some(f => {
        const content = twin.files[f]?.content;
        return content && /nginx-proxy-manager|jc21\/nginx-proxy-manager/i.test(content);
    });

    if (isNpm) {
        debug.push(`Node "${nodeName}": NPM detected, trying DATA_DIR fallback`);
        const npmPaths = await buildNpmFallbackPaths(debug);
        if (npmPaths.length > 0) {
            const probed = await probeProxyVolumes(nodeName, npmPaths, debug);
            if (probed) {
                logger.info('NginxConfDir', `Resolved conf.d via NPM DATA_DIR fallback: ${probed} on ${nodeName}`);
                return probed;
            }
        }
    }

    return null;
}

/**
 * Check if a pod doc is a proxy based on its metadata.
 */
function isProxyPod(
    labels: Record<string, string>,
    podName: string,
    proxyState: { provider: string; routes: unknown[] },
): boolean {
    return labels['servicebay.role'] === 'reverse-proxy'
        || /nginx|proxy/i.test(podName)
        || (proxyState?.provider === 'nginx' && /nginx/i.test(podName));
}

/**
 * Build volume mount map from pod containers.
 */
function buildVolumeMap(
    containers: Array<Record<string, unknown>>,
): Map<string, string> {
    const mountMap = new Map<string, string>();
    for (const ct of containers) {
        for (const vm of (ct.volumeMounts || []) as Array<Record<string, string>>) {
            if (vm.name && vm.mountPath) mountMap.set(vm.name, vm.mountPath);
        }
    }
    return mountMap;
}

/**
 * Check a single pod doc for proxy volumes; extracted from probeNginxConfFromKube.
 */
function checkPodVolumes(
    doc: Record<string, unknown>,
    filePath: string,
    proxyState: { provider: string; routes: unknown[] },
    debug: string[],
): string | null {
    if (!doc?.spec) return null;
    const spec = doc.spec as Record<string, unknown>;
    const meta = doc.metadata as Record<string, unknown> | undefined;
    const labels = (meta?.labels || {}) as Record<string, string>;
    const podName = (meta?.name || '') as string;
    if (!isProxyPod(labels, podName, proxyState)) {
        debug.push(`  ${filePath}: pod "${podName}" is not a proxy`);
        return null;
    }
    debug.push(`  ${filePath}: pod "${podName}" identified as proxy`);
    const volumes = (spec.volumes || []) as Array<Record<string, unknown>>;
    const containers = (spec.containers || []) as Array<Record<string, unknown>>;
    const mountMap = buildVolumeMap(containers);
    debug.push(`  ${filePath}: ${volumes.length} volumes, mounts: ${JSON.stringify(Object.fromEntries(mountMap))}`);
    for (const vol of volumes) {
        const hp = vol.hostPath as Record<string, string> | undefined;
        const volName = vol.name as string;
        if (!hp?.path) continue;
        const containerDest = mountMap.get(volName) || '';
        if (containerDest === '/etc/nginx/conf.d') {
            debug.push(`  MATCH: volume "${volName}" → hostPath "${hp.path}"`);
            return hp.path;
        }
    }
    return null;
}

/**
 * Parse a kube YAML (Pod manifest) looking for nginx conf.d volume mount.
 * Returns the exact hostPath on match, or null.
 */
async function probeNginxConfFromKube(
    content: string | undefined,
    filePath: string,
    proxyState: { provider: string; routes: unknown[] },
    debug: string[],
): Promise<string | null> {
    if (!content) {
        debug.push(`  ${filePath}: no content`);
        return null;
    }
    try {
        const docs = yaml.loadAll(content) as Record<string, unknown>[];
        for (const doc of docs) {
            const confDir = checkPodVolumes(doc, filePath, proxyState, debug);
            if (confDir) return confDir;
        }
    } catch (e) {
        debug.push(`  ${filePath}: YAML parse error: ${e}`);
    }
    return null;
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

