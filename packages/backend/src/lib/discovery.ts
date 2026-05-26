/**
 * Read-only discovery of systemd-managed and ad-hoc Podman services
 * (#721 — migration logic moved to `lib/migration.ts`).
 *
 * `discoverSystemdServices()` groups running containers by their
 * `PODMAN_SYSTEMD_UNIT` label, looks up each unit's FragmentPath /
 * SourcePath via `systemctl --user show`, and returns a
 * `DiscoveredService[]` the wizard + Settings → Discovery surfaces.
 * Pure inspection: no mutations on disk or systemd. The mutation
 * cousins (`migrateService`, `mergeServices`) consume this output but
 * live in their own module.
 *
 * `deleteBundleResources` lives here rather than in migration.ts
 * because it operates on an *already-identified* unmanaged bundle —
 * the inverse of discovery — and shares the same primitive set
 * (executor.execArgv on `systemctl --user disable --now`, file
 * removal). Migration is about transforming bundles into managed
 * Quadlets; deletion is about purging them.
 */

import { getPodmanPs } from './manager';
import { getExecutor, Executor } from './executor';
import { PodmanConnection } from './nodes';
import path from 'path';
import type { ServiceBundle } from './unmanaged/bundleShared';
import { logger } from './logger';

export function getSystemdDir() {
    // V4: All operations go through the agent which runs on the host.
    // Always use relative path - it resolves to the host user's home directory.
    return '.config/containers/systemd';
}

export function getBackupDir() {
    return path.join(getSystemdDir(), 'backups');
}

export async function inspectItem(executor: Executor, id: string, type: 'container' | 'pod' = 'container') {
    try {
        const { stdout } = await executor.execArgv(['podman', 'inspect', ...(type === 'pod' ? ['--type', 'pod'] : ['--type', 'container']), id]);
        const data = JSON.parse(stdout);
        return Array.isArray(data) ? data[0] : data;
    } catch (e) {
        logger.warn('discovery', `Failed to inspect ${type} ${id}`, e);
        return null;
    }
}

export interface DiscoveredService {
    serviceName: string;
    containerNames: string[];
    containerIds: string[];
    podId?: string;
    unitFile?: string;
    sourcePath?: string;
    status: 'managed' | 'unmanaged';
    type: 'kube' | 'container' | 'pod' | 'compose' | 'other';
    nodeName?: string;
    discoveryHints?: string[];
}

export interface DeleteBundleResult {
    stoppedUnits: string[];
    removedFiles: string[];
    missingFiles: string[];
}

export async function discoverSystemdServices(connection?: PodmanConnection): Promise<DiscoveredService[]> {
    if (!connection) {
        return [];
    }
    const executor = getExecutor(connection);
    const containers = await getPodmanPs(connection);
    const servicesMap = new Map<string, { names: string[], ids: string[], podId?: string }>();
    const nodeLabel = connection?.Name || 'Local';

    // Group containers by systemd unit
    for (const container of containers) {
        const unit = container.Labels?.['PODMAN_SYSTEMD_UNIT'];
        if (unit) {
            const current: { names: string[], ids: string[], podId?: string } = servicesMap.get(unit) || { names: [], ids: [], podId: container.Pod };
            // Clean up container name
            const name = container.Names && container.Names.length > 0 ? container.Names[0].replace(/^\//, '') : container.Id.substring(0, 12);

            current.names.push(name);
            current.ids.push(container.Id);

            servicesMap.set(unit, current);
        }
    }

    const results: DiscoveredService[] = [];

    for (const [serviceName, data] of servicesMap.entries()) {
        const containerNames = data.names;
        const containerIds = data.ids;
        const podId = data.podId;
        let unitFile: string | undefined;
        let sourcePath: string | undefined;
        let type: DiscoveredService['type'] = 'other';
        let status: DiscoveredService['status'] = 'unmanaged';
        const discoveryHints: string[] = [];

        try {
            // Try with the service name as is
            let cmd = `systemctl --user show -p FragmentPath -p SourcePath "${serviceName}"`;
            let { stdout } = await executor.exec(cmd);

            // If empty output or properties missing, try appending .service if not present
            if ((!stdout || (!stdout.includes('FragmentPath=') && !stdout.includes('SourcePath='))) && !serviceName.endsWith('.service')) {
                 cmd = `systemctl --user show -p FragmentPath -p SourcePath "${serviceName}.service"`;
                 const res = await executor.exec(cmd);
                 stdout = res.stdout;
            }

            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.startsWith('FragmentPath=')) unitFile = line.substring(13);
                if (line.startsWith('SourcePath=')) sourcePath = line.substring(11);
            }

            // Fallback: Check common locations if unitFile is still empty
            if (!unitFile) {
                 // Get home dir dynamically (remote or local)
                 const { stdout: homeDir } = await executor.exec('echo $HOME');
                 const cleanHome = homeDir.trim();

                 const commonPaths = [
                     path.join(cleanHome, '.config/systemd/user', serviceName),
                     path.join(cleanHome, '.config/systemd/user', `${serviceName}.service`),
                     `/etc/systemd/user/${serviceName}`,
                     `/etc/systemd/user/${serviceName}.service`
                 ];

                 for (const p of commonPaths) {
                     if (await executor.exists(p)) {
                         unitFile = p;
                         break;
                     }
                 }
            }

        } catch (e) {
            logger.error('discovery', `Failed to inspect service ${serviceName}`, e);
        }

        // Determine Type
        if (serviceName.includes('podman-compose')) {
            type = 'compose';
        } else if (sourcePath) {
             if (sourcePath.endsWith('.kube')) type = 'kube';
             else if (sourcePath.endsWith('.container')) type = 'container';
             else if (sourcePath.endsWith('.pod')) type = 'pod';
        }

        // Determine Status (Managed by ServiceBay?)
        // ServiceBay currently manages .kube files in the SYSTEMD_DIR
        // We need to check if sourcePath is within SYSTEMD_DIR
        // Since paths might be absolute or relative, and we are remote, this is tricky.
        // But usually SYSTEMD_DIR is ~/.config/containers/systemd

        if ((type === 'kube' || type === 'container' || type === 'pod') && sourcePath && sourcePath.includes('.config/containers/systemd')) {
            status = 'managed';
        }

        // Filter out empty paths if they are empty strings
        if (!unitFile) unitFile = undefined;
        if (!sourcePath) sourcePath = undefined;

        if (unitFile) discoveryHints.push(`Unit: ${unitFile}`);
        if (sourcePath && sourcePath !== unitFile) discoveryHints.push(`Source: ${sourcePath}`);
        if (podId) discoveryHints.push(`Pod: ${podId}`);
        if (containerIds.length > 0) discoveryHints.push(`Containers: ${containerIds.map(id => id.substring(0, 12)).join(', ')}`);

        results.push({
            serviceName,
            containerNames,
            containerIds,
            podId,
            unitFile,
            sourcePath,
            status,
            type,
            nodeName: nodeLabel,
            discoveryHints
        });
    }

    return results;
}

export async function deleteBundleResources(bundle: ServiceBundle, connection?: PodmanConnection): Promise<DeleteBundleResult> {
    if (!bundle) {
        throw new Error('Bundle is required for deletion.');
    }

    const executor = getExecutor(connection);
    const stoppedUnits: string[] = [];
    const removedFiles: string[] = [];
    const missingFiles: string[] = [];

    const serviceUnits = new Set<string>();
    const fileCandidates = new Set<string>();

    bundle.services.forEach(service => {
        if (service.serviceName) {
            const normalized = service.serviceName.endsWith('.service') ? service.serviceName : `${service.serviceName}.service`;
            serviceUnits.add(normalized);
        }
        if (service.unitFile) {
            fileCandidates.add(service.unitFile);
        }
        if (service.sourcePath) {
            fileCandidates.add(service.sourcePath);
        }
    });

    bundle.assets?.forEach(asset => {
        if (asset.path) {
            fileCandidates.add(asset.path);
        }
    });

    for (const unit of serviceUnits) {
        try {
            await executor.execArgv(['systemctl', '--user', 'disable', '--now', unit]);
            await executor.execArgv(['systemctl', '--user', 'reset-failed', unit]);
            stoppedUnits.push(unit);
        } catch (error) {
            logger.warn('discovery', `Failed to disable unmanaged unit ${unit}`, error);
        }
    }

    const needsHomeDir = Array.from(fileCandidates).some(candidate => candidate && !candidate.trim().startsWith('/'));
    let homeDir: string | undefined;
    if (needsHomeDir) {
        try {
            const { stdout } = await executor.exec('echo $HOME');
            homeDir = stdout.trim() || undefined;
        } catch (error) {
            logger.warn('discovery', 'Unable to resolve remote home directory for bundle deletion', error);
        }
    }

    const normalizeRemotePath = (raw: string | undefined): string | null => {
        if (!raw) return null;
        let value = raw.trim();
        if (!value) return null;

        if (value.startsWith('~')) {
            if (!homeDir) return null;
            value = `${homeDir}${value.slice(1)}`;
        } else if (!value.startsWith('/')) {
            if (!homeDir) return null;
            value = path.posix.resolve(homeDir, value);
        }

        if (!value.startsWith('/')) return null;
        if (value === '/' || (homeDir && value === homeDir)) return null;
        return value;
    };

    for (const target of fileCandidates) {
        const absolutePath = normalizeRemotePath(target);
        if (!absolutePath) continue;

        try {
            const exists = await executor.exists(absolutePath);
            if (!exists) {
                missingFiles.push(absolutePath);
                continue;
            }
            await executor.rm(absolutePath);
            removedFiles.push(absolutePath);
        } catch (error) {
            logger.warn('discovery', `Failed to remove bundle asset ${absolutePath}`, error);
        }
    }

    try {
        await executor.exec('systemctl --user daemon-reload');
    } catch (error) {
        logger.warn('discovery', 'Failed to reload systemd after deleting unmanaged bundle', error);
    }

    return { stoppedUnits, removedFiles, missingFiles };
}
