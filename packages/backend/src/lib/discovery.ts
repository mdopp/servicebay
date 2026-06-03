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

async function parseSystemdUnitLine(
    serviceName: string,
    executor: Executor
): Promise<{ unitFile?: string; sourcePath?: string }> {
    let unitFile: string | undefined;
    let sourcePath: string | undefined;

    try {
        // #1097: route systemctl through execArgv so the shell never
        // sees serviceName as part of a command-line string. The
        // upstream regex validator already constrains the input, but
        // argv-based exec removes the shell-injection class entirely
        // and matches the convention the rest of the codebase uses.
        let { stdout } = await executor.execArgv(['systemctl', '--user', 'show', '-p', 'FragmentPath', '-p', 'SourcePath', serviceName]);

        // If empty output or properties missing, try appending .service if not present
        if ((!stdout || (!stdout.includes('FragmentPath=') && !stdout.includes('SourcePath='))) && !serviceName.endsWith('.service')) {
             const res = await executor.execArgv(['systemctl', '--user', 'show', '-p', 'FragmentPath', '-p', 'SourcePath', `${serviceName}.service`]);
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

    return { unitFile, sourcePath };
}

function determineServiceType(serviceName: string, sourcePath?: string): DiscoveredService['type'] {
    if (serviceName.includes('podman-compose')) {
        return 'compose';
    }
    if (sourcePath) {
        if (sourcePath.endsWith('.kube')) return 'kube';
        if (sourcePath.endsWith('.container')) return 'container';
        if (sourcePath.endsWith('.pod')) return 'pod';
    }
    return 'other';
}

function determineServiceStatus(type: DiscoveredService['type'], sourcePath?: string): DiscoveredService['status'] {
    if ((type === 'kube' || type === 'container' || type === 'pod') && sourcePath?.includes('.config/containers/systemd')) {
        return 'managed';
    }
    return 'unmanaged';
}

function buildDiscoveryHints(unitFile?: string, sourcePath?: string, podId?: string, containerIds?: string[]): string[] {
    const hints: string[] = [];
    if (unitFile) hints.push(`Unit: ${unitFile}`);
    if (sourcePath && sourcePath !== unitFile) hints.push(`Source: ${sourcePath}`);
    if (podId) hints.push(`Pod: ${podId}`);
    if (containerIds?.length) hints.push(`Containers: ${containerIds.map(id => id.substring(0, 12)).join(', ')}`);
    return hints;
}

export async function discoverSystemdServices(connection?: PodmanConnection): Promise<DiscoveredService[]> {
    if (!connection) return [];
    const executor = getExecutor(connection);
    const containers = await getPodmanPs(connection);
    const servicesMap = new Map<string, { names: string[], ids: string[], podId?: string }>();

    for (const container of containers) {
        const unit = container.Labels?.['PODMAN_SYSTEMD_UNIT'];
        if (!unit) continue;
        const current: { names: string[], ids: string[], podId?: string } = servicesMap.get(unit) || { names: [], ids: [], podId: container.Pod };
        const name = container.Names?.[0]?.replace(/^\//, '') ?? container.Id.substring(0, 12);
        current.names.push(name);
        current.ids.push(container.Id);
        servicesMap.set(unit, current);
    }

    const nodeLabel = connection?.Name || 'Local';
    const results: DiscoveredService[] = [];
    for (const [serviceName, data] of servicesMap.entries()) {
        const { unitFile, sourcePath } = await parseSystemdUnitLine(serviceName, executor);
        const type = determineServiceType(serviceName, sourcePath);
        const status = determineServiceStatus(type, sourcePath);
        const discoveryHints = buildDiscoveryHints(unitFile, sourcePath, data.podId, data.ids);

        results.push({
            serviceName,
            containerNames: data.names,
            containerIds: data.ids,
            podId: data.podId,
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

async function removeUnitFiles(
    executor: Executor,
    fileCandidates: Set<string>,
    homeDir: string | undefined
): Promise<{ removedFiles: string[]; missingFiles: string[] }> {
    const removedFiles: string[] = [];
    const missingFiles: string[] = [];

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

    return { removedFiles, missingFiles };
}

export async function deleteBundleResources(bundle: ServiceBundle, connection?: PodmanConnection): Promise<DeleteBundleResult> {
    if (!bundle) {
        throw new Error('Bundle is required for deletion.');
    }

    const executor = getExecutor(connection);
    const stoppedUnits: string[] = [];
    const fileCandidates = new Set<string>();

    // Collect serviceUnits and fileCandidates from bundle
    const serviceUnits = new Set<string>();
    bundle.services.forEach(service => {
        if (service.serviceName) {
            const normalized = service.serviceName.endsWith('.service') ? service.serviceName : `${service.serviceName}.service`;
            serviceUnits.add(normalized);
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

    const { removedFiles, missingFiles } = await removeUnitFiles(executor, fileCandidates, homeDir);

    try {
        await executor.exec('systemctl --user daemon-reload');
    } catch (error) {
        logger.warn('discovery', 'Failed to reload systemd after deleting unmanaged bundle', error);
    }

    return { stoppedUnits, removedFiles, missingFiles };
}
