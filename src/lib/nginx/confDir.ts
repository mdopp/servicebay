import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import yaml from 'js-yaml';

/**
 * Find the nginx node and the conf.d host path by parsing the Digital Twin's
 * stored YAML — same source of truth as the backup system (systemBackup.ts).
 */
export async function findNginxConfDir(): Promise<{ nodeName: string; confDir: string } | null> {
    const twinStore = DigitalTwinStore.getInstance();
    const nodeNames = Object.keys(twinStore.nodes);
    if (nodeNames.length === 0) nodeNames.push('Local');

    for (const nodeName of nodeNames) {
        const services = await ServiceManager.listServices(nodeName);
        const nginxService = services.find(s =>
            s.name === 'nginx-web' ||
            s.name.includes('nginx') ||
            s.description?.toLowerCase().includes('nginx')
        );
        if (!nginxService) continue;

        const twin = twinStore.nodes[nodeName];
        if (!twin?.files) continue;

        for (const [filePath, file] of Object.entries(twin.files)) {
            if (!filePath.endsWith('.yml') && !filePath.endsWith('.yaml')) continue;
            if (!file.content) continue;

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
                    if (!isProxy) continue;

                    const volumes = (spec.volumes || []) as Array<Record<string, unknown>>;
                    const containers = (spec.containers || []) as Array<Record<string, unknown>>;
                    const mountMap = new Map<string, string>();
                    for (const ct of containers) {
                        for (const vm of (ct.volumeMounts || []) as Array<Record<string, string>>) {
                            if (vm.name && vm.mountPath) mountMap.set(vm.name, vm.mountPath);
                        }
                    }

                    for (const vol of volumes) {
                        const hp = vol.hostPath as Record<string, string> | undefined;
                        if (!hp?.path) continue;
                        const volName = vol.name as string;
                        const containerDest = mountMap.get(volName) || '';
                        if (containerDest === '/etc/nginx/conf.d') {
                            return { nodeName, confDir: hp.path };
                        }
                    }
                }
            } catch {
                // skip unparseable
            }
        }

        // Found the service but couldn't parse conf.d path from YAML
        return { nodeName, confDir: '' };
    }

    return null;
}
