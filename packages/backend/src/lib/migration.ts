/**
 * Service migration / merge engine (#721).
 *
 * Extracted from `lib/discovery.ts` so that discovery stays a
 * read-only inspection module. Migration mutates state on disk +
 * in systemd; keeping the two layers separated lets the diagnose
 * stack import discovery without dragging in backup-archive +
 * rollback machinery, and lets reviewers reason about either
 * concern in isolation.
 *
 * Public entry points:
 *   - `migrateService(service, customName?, dryRun?, connection?)` —
 *     adopts a single discovered service into the managed
 *     `~/.config/containers/systemd/<name>.{kube,yml}` layout, with
 *     pre-migrate validation (dry-run kube play) when called with
 *     `dryRun: true` and on-failure rollback via `RollbackContext`.
 *   - `mergeServices(services[], newName, options)` — combines
 *     multiple discovered services into a single managed Pod under
 *     the same destination scheme. Dry-run support, archive, and
 *     rollback semantics mirror migrateService.
 *
 * Both entry points record their outcome on
 * `DigitalTwinStore.migrationHistory[node]` so the dashboard can
 * surface success / rolled_back / failed across page reloads.
 */

import { getExecutor, Executor } from './executor';
import { PodmanConnection } from './nodes';
import path from 'path';
import yaml from 'js-yaml';
import { injectServiceDirectives } from './services/quadletDirectives';
import { randomUUID } from 'crypto';
import { saveSnapshot } from './history';
import { MigrationHistoryEntry } from './store/twin';
import { recordMigrationEvent } from './store/repository';
import {
    type DiscoveredService,
    getSystemdDir,
    getBackupDir,
    inspectItem,
} from './discovery';
import { logger } from './logger';

export type { DiscoveredService } from './discovery';

export interface PlanValidation {
    level: 'info' | 'warning' | 'error';
    message: string;
    scope?: string;
}

export interface PlanFileMapping {
    source: string;
    action: 'backup' | 'migrate';
    target?: string;
}

export interface MergeOptions {
    dryRun?: boolean;
    connection?: PodmanConnection;
    initiator?: string;
}

export interface MigrationPlan {
    filesToCreate: string[];
    filesToBackup: string[];
    servicesToStop: string[];
    targetName: string;
    backupDir: string;
    stackPreview?: string;
    validations?: PlanValidation[];
    fileMappings?: PlanFileMapping[];
    backupArchive?: string;
}

interface BackupManifest {
    createdAt: string;
    targetName: string;
    nodeName: string;
    files: string[];
}

interface RollbackContext {
    executor: Executor;
    targetUnit: string;
    archivePath?: string;
    stoppedServices: string[];
}

type PlanDetail = Pick<MigrationPlan, 'stackPreview' | 'validations' | 'fileMappings'>;

const STACK_PREVIEW_FALLBACK = '# Unable to build stack preview. See validations for details.';
const SERVICE_HEALTH_TIMEOUT = 20000;
const SERVICE_HEALTH_INTERVAL = 1500;
const TMP_STACK_PREFIX = '/tmp/servicebay-stack';
const BACKUP_TIMESTAMP_PATTERN = /[:.]/g;

function sanitizePodName(name: string): string {
    // Kubernetes Pod names must consist of lower case alphanumeric characters, '-' or '.',
    // and must start and end with an alphanumeric character.
    return name.toLowerCase()
        .replace(/[^a-z0-9-.]/g, '-')
        .replace(/^-+|-+$/g, '');
}

const createTempStackPath = (context: string) => {
    const safeToken = sanitizePodName(context || 'bundle') || 'bundle';
    const random = Math.random().toString(36).slice(2, 8);
    return `${TMP_STACK_PREFIX}-${safeToken}-${Date.now().toString(36)}-${random}.yml`;
};

const describeArchivePattern = (backupDir: string, name: string) => {
    const safeName = sanitizePodName(name) || 'bundle';
    return path.join(backupDir, `${safeName}-<timestamp>.tar.gz`);
};

const describeRuntimeSource = (service: DiscoveredService): string => {
    if (service.podId) return `pod:${service.podId}`;
    if (service.containerIds && service.containerIds.length > 0) {
        return `containers:${service.containerIds.map(id => id.substring(0, 12)).join(',')}`;
    }
    return service.serviceName || 'unknown';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sanitizeYamlDocument = (doc: any, cleanName: string) => {
    if (!doc) return doc;
    if (!doc.metadata) doc.metadata = {};
    doc.metadata.name = sanitizePodName(cleanName);
    if (doc.spec?.hostname) {
        doc.spec.hostname = sanitizePodName(doc.spec.hostname);
    }
    if (doc.spec?.containers) {
        doc.spec.containers.forEach((container: { name?: string }) => {
            if (container?.name) {
                container.name = sanitizePodName(container.name);
            }
        });
    }
    return doc;
};

async function createBackup(executor: Executor, filePath: string, serviceName: string, connection?: PodmanConnection) {
    if (!await executor.exists(filePath)) {
        return; // File doesn't exist, nothing to backup
    }

    const fileName = path.basename(filePath);
    const content = await executor.readFile(filePath);

    // Save to history
    try {
        await saveSnapshot(fileName, content, connection);
    } catch (e) {
        throw new Error(`Failed to create backup for ${fileName}: ${e}`);
    }
}

async function runDryRunValidation(
    executor: Executor,
    yamlContent: string,
    contextName: string
): Promise<PlanValidation[]> {
    const validations: PlanValidation[] = [];
    const tempYamlPath = createTempStackPath(contextName);
    const dryRunCommands = ['podman kube play --dry-run', 'podman play kube --dry-run'];
    try {
        await executor.writeFile(tempYamlPath, yamlContent);
        let succeeded = false;
        let lastError: string | undefined;
        for (const cmd of dryRunCommands) {
            try {
                await executor.execArgv([...cmd.split(' '), tempYamlPath]);
                validations.push({
                    level: 'info',
                    message: `${cmd} succeeded`,
                    scope: contextName
                });
                succeeded = true;
                break;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        }
        if (!succeeded) {
            validations.push({
                level: 'error',
                message: `Dry-run validation failed: ${lastError || 'unknown error'}`,
                scope: contextName
            });
        }
    } catch (error) {
        validations.push({
            level: 'error',
            message: `Unable to execute dry-run validation: ${(error as Error).message}`,
            scope: contextName
        });
    } finally {
        try {
            await executor.rm(tempYamlPath);
        } catch {
            // Ignore cleanup failures
        }
    }
    return validations;
}

async function createBackupArchive(
    executor: Executor,
    files: string[],
    backupDir: string,
    targetName: string,
    nodeName = 'Local'
): Promise<string | undefined> {
    if (!files.length) return undefined;
    const existingFiles: string[] = [];
    for (const filePath of files) {
        if (await executor.exists(filePath)) {
            existingFiles.push(filePath);
        }
    }
    if (existingFiles.length === 0) {
        return undefined;
    }

    await executor.mkdir(backupDir);
    const timestamp = new Date().toISOString().replace(BACKUP_TIMESTAMP_PATTERN, '-');
    const safeName = sanitizePodName(targetName) || 'bundle';
    const baseName = `${safeName}-${timestamp}`;
    const manifestPath = path.join(backupDir, `${baseName}.manifest.json`);
    const archivePath = path.join(backupDir, `${baseName}.tar.gz`);
    const listPath = path.join(backupDir, `${baseName}.lst`);

    const manifest: BackupManifest = {
        createdAt: new Date().toISOString(),
        targetName,
        nodeName,
        files: existingFiles
    };

    await executor.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const filesForArchive = [...existingFiles, manifestPath];
    await executor.writeFile(listPath, filesForArchive.join('\n'));

    try {
        await executor.execArgv(['tar', '-czf', archivePath, '-T', listPath]);
    } finally {
        try {
            await executor.rm(listPath);
        } catch {
            // Ignore cleanup failures
        }
    }

    return archivePath;
}

function collectBackupCandidates(services: DiscoveredService[], extraPaths: string[]): string[] {
    const candidates = new Set<string>();
    extraPaths.filter(Boolean).forEach(p => candidates.add(p));
    services.forEach(service => {
        if (service.sourcePath) candidates.add(service.sourcePath);
        if (service.unitFile) candidates.add(service.unitFile);
    });
    return Array.from(candidates);
}

async function waitForServiceHealthy(executor: Executor, unitName: string) {
    const start = Date.now();
    while (Date.now() - start < SERVICE_HEALTH_TIMEOUT) {
        try {
            const { stdout } = await executor.execArgv(['systemctl', '--user', 'show', unitName, '--property=ActiveState', '--value']);
            if (stdout.trim() === 'active') {
                return;
            }
        } catch {
            // Ignore transient failures; retry until timeout
        }
        await new Promise(resolve => setTimeout(resolve, SERVICE_HEALTH_INTERVAL));
    }
    throw new Error(`Service ${unitName} failed to reach active state within ${SERVICE_HEALTH_TIMEOUT}ms`);
}

async function stopLegacyServices(executor: Executor, services: DiscoveredService[]): Promise<string[]> {
    const stopped: string[] = [];
    for (const service of services) {
        const unitName = service.serviceName;
        if (!unitName || stopped.includes(unitName)) continue;
        try {
            logger.info('migration', `Stopping old service ${unitName}...`);
            await executor.execArgv(['systemctl', '--user', 'disable', '--now', unitName]);
            stopped.push(unitName);
        } catch (error) {
            logger.warn('migration', `Failed to stop service ${unitName}`, error);
        }
    }
    return stopped;
}

async function rollbackManagedService({ executor, targetUnit, archivePath, stoppedServices }: RollbackContext): Promise<boolean> {
    let success = true;

    try {
        await executor.execArgv(['systemctl', '--user', 'disable', '--now', targetUnit]);
    } catch (error) {
        logger.warn('migration', `Failed to stop ${targetUnit} during rollback`, error);
        success = false;
    }

    if (archivePath) {
        try {
            await executor.execArgv(['tar', '-xzf', archivePath, '-P']);
        } catch (error) {
            logger.warn('migration', 'Failed to restore backup archive', error);
            success = false;
        }
    }

    try {
        await executor.exec('systemctl --user daemon-reload');
    } catch (error) {
        logger.warn('migration', 'Failed to reload systemd during rollback', error);
        success = false;
    }

    for (const legacyUnit of stoppedServices) {
        try {
            await executor.execArgv(['systemctl', '--user', 'enable', '--now', legacyUnit]);
        } catch (error) {
            logger.warn('migration', `Failed to re-enable ${legacyUnit} during rollback`, error);
            success = false;
        }
    }

    return success;
}

function recordMigrationHistory(params: {
    status: MigrationHistoryEntry['status'];
    targetName: string;
    nodeName: string;
    services: DiscoveredService[];
    actor?: string;
    backupArchive?: string;
    error?: string;
}) {
    try {
        const entry: MigrationHistoryEntry = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            actor: params.actor || 'unknown',
            targetName: params.targetName,
            nodeName: params.nodeName,
            bundleSize: params.services.length,
            services: params.services.map(service => ({
                name: service.serviceName,
                sourcePath: service.sourcePath,
                unitFile: service.unitFile,
                containerIds: service.containerIds
            })),
            backupArchive: params.backupArchive,
            status: params.status,
            error: params.error
        };
        recordMigrationEvent(params.nodeName, entry);
    } catch (error) {
        logger.warn('migration', 'Failed to record migration history', error);
    }
}

async function analyzeRuntimeContext(service: DiscoveredService, executor: Executor) {
    let hostNetwork = false;
    const privilegedContainers = new Set<string>();

    const inspectContainer = async (containerId: string) => {
        const details = await inspectItem(executor, containerId, 'container');
        if (!details?.HostConfig) return;
        if (details.HostConfig.NetworkMode === 'host') hostNetwork = true;
        if (details.HostConfig.Privileged) {
            const safeName = (details.Name || containerId).replace(/^\//, '');
            privilegedContainers.add(safeName);
            privilegedContainers.add(sanitizePodName(safeName));
        }
    };

    try {
        if (service.podId) {
            const podDetails = await inspectItem(executor, service.podId, 'pod');
            if (podDetails?.InfraContainerID) {
                await inspectContainer(podDetails.InfraContainerID);
            }
            for (const cid of service.containerIds) {
                await inspectContainer(cid);
            }
        } else {
            for (const cid of service.containerIds) {
                await inspectContainer(cid);
            }
        }
    } catch (error) {
        logger.warn('migration', 'Failed to inspect runtime context', error);
    }

    return { hostNetwork, privilegedContainers };
}

async function buildStackPreviewForService(
    service: DiscoveredService,
    cleanName: string,
    targetPaths: { kube: string; yaml: string },
    executor: Executor
): Promise<PlanDetail> {
    const validations: PlanValidation[] = [];
    const fileMappings: PlanFileMapping[] = [];
    const mappingKeys = new Set<string>();
    let stackPreview = '';
    let previewFormat: 'yaml' | 'quadlet' | 'none' = 'none';

    const addMapping = (source?: string, action: PlanFileMapping['action'] = 'migrate', target?: string) => {
        if (!source) return;
        const key = `${source}::${action}::${target || ''}`;
        if (mappingKeys.has(key)) return;
        mappingKeys.add(key);
        fileMappings.push({ source, action, target });
    };

    if (service.type === 'kube' && service.sourcePath) {
        addMapping(service.sourcePath, 'migrate', targetPaths.kube);
        try {
            const kubeContent = await executor.readFile(service.sourcePath);
            const yamlMatch = kubeContent.match(/Yaml=(.+)/);
            if (yamlMatch) {
                const yamlRef = yamlMatch[1].trim();
                const sourceDir = path.dirname(service.sourcePath);
                const yamlPath = path.isAbsolute(yamlRef) ? yamlRef : path.join(sourceDir, yamlRef);
                addMapping(yamlPath, 'migrate', targetPaths.yaml);
                try {
                    const yamlContent = await executor.readFile(yamlPath);
                    const parsed = sanitizeYamlDocument(yaml.load(yamlContent), cleanName);
                    stackPreview = parsed ? yaml.dump(parsed) : yamlContent;
                    previewFormat = 'yaml';
                } catch (error) {
                    validations.push({
                        level: 'error',
                        message: `Failed to read referenced YAML ${yamlPath}: ${(error as Error).message}`,
                        scope: service.serviceName
                    });
                }
            } else {
                validations.push({
                    level: 'warning',
                    message: 'Source kube file does not reference a YAML document',
                    scope: service.serviceName
                });
                stackPreview = kubeContent;
                previewFormat = 'quadlet';
            }
        } catch (error) {
            validations.push({
                level: 'error',
                message: `Unable to read ${service.sourcePath}: ${(error as Error).message}`,
                scope: service.serviceName
            });
        }
    } else if (service.podId || (service.containerIds && service.containerIds.length > 0)) {
        addMapping(describeRuntimeSource(service), 'migrate', targetPaths.yaml);
        try {
            const targetIds = service.podId ? service.podId : service.containerIds.join(' ');
            const { stdout } = await executor.execArgv(['podman', 'generate', 'kube', ...targetIds.split(' ').filter(Boolean)]);
            const parsed = sanitizeYamlDocument(yaml.load(stdout), cleanName) || {};
            const { hostNetwork, privilegedContainers } = await analyzeRuntimeContext(service, executor);

            if (!parsed.spec) parsed.spec = {};
            if (hostNetwork) {
                parsed.spec.hostNetwork = true;
                if (!parsed.spec.dnsPolicy) {
                    parsed.spec.dnsPolicy = 'ClusterFirstWithHostNet';
                }
                validations.push({
                    level: 'info',
                    message: 'Host network mode detected; generated stack enables hostNetwork',
                    scope: service.serviceName
                });
            }

            if (parsed.spec.containers) {
                parsed.spec.containers.forEach((container: { name?: string; securityContext?: { privileged?: boolean } }) => {
                    if (!container?.name) return;
                    const originalName = container.name;
                    container.name = sanitizePodName(container.name);
                    if (privilegedContainers.has(originalName) || privilegedContainers.has(container.name)) {
                        if (!container.securityContext) container.securityContext = {};
                        container.securityContext.privileged = true;
                    }
                });
            }

            if (privilegedContainers.size > 0) {
                validations.push({
                    level: 'warning',
                    message: `Privileged containers detected: ${Array.from(privilegedContainers).join(', ')}`,
                    scope: service.serviceName
                });
            }

            stackPreview = yaml.dump(parsed);
            previewFormat = 'yaml';
        } catch (error) {
            validations.push({
                level: 'error',
                message: `Failed to generate kube output: ${(error as Error).message}`,
                scope: service.serviceName
            });
        }
    } else {
        validations.push({
            level: 'error',
            message: 'No source artifacts found for this service',
            scope: service.serviceName
        });
    }

    const preview = stackPreview || STACK_PREVIEW_FALLBACK;
    if (previewFormat === 'yaml' && stackPreview) {
        const dryRunResults = await runDryRunValidation(executor, stackPreview, cleanName);
        validations.push(...dryRunResults);
    } else if (previewFormat === 'quadlet') {
        validations.push({
            level: 'warning',
            message: 'Dry-run skipped because the Quadlet unit did not reference a YAML document',
            scope: service.serviceName
        });
    }

    return {
        stackPreview: preview,
        validations,
        fileMappings
    };
}

async function collectGeneratedPodSpecs(services: DiscoveredService[], executor: Executor) {
    const podYamls: unknown[] = [];
    const processedPodIds = new Set<string>();
    const standaloneContainerIds: string[] = [];

    for (const service of services) {
        if (service.podId) {
            if (processedPodIds.has(service.podId)) {
                continue;
            }
            processedPodIds.add(service.podId);
            try {
                const { stdout } = await executor.execArgv(['podman', 'generate', 'kube', service.podId!]);
                podYamls.push(yaml.load(stdout));
            } catch (error) {
                logger.warn('migration', `Failed to generate kube for pod ${service.podId}`, error);
                throw error;
            }
        } else if (service.containerIds.length > 0) {
            standaloneContainerIds.push(...service.containerIds);
        }
    }

    if (standaloneContainerIds.length > 0) {
        try {
            const { stdout } = await executor.execArgv(['podman', 'generate', 'kube', ...standaloneContainerIds]);
            podYamls.push(yaml.load(stdout));
        } catch (error) {
            logger.warn('migration', 'Failed to generate kube for standalone containers', error);
            throw error;
        }
    }

    if (podYamls.length === 0) {
        throw new Error('Failed to generate any YAMLs');
    }

    return podYamls;
}

function mergePodSpecs(podYamls: unknown[], newName: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mergedPod = podYamls[0] as any;
    if (!mergedPod?.metadata) {
        mergedPod.metadata = {};
    }
    mergedPod.metadata.name = newName;
    if (mergedPod.metadata) {
        delete mergedPod.metadata.creationTimestamp;
    }
    if (mergedPod.status) {
        delete mergedPod.status;
    }

    for (let i = 1; i < podYamls.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const other = podYamls[i] as any;
        if (!other?.spec) continue;

        if (other.spec.containers) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            other.spec.containers.forEach((container: any) => {
                if (!mergedPod.spec.containers) mergedPod.spec.containers = [];
                const exists = mergedPod.spec.containers.find((c: { name: string }) => c.name === container.name);
                if (!exists) {
                    mergedPod.spec.containers.push(container);
                }
            });
        }

        if (other.spec.initContainers) {
            mergedPod.spec.initContainers = mergedPod.spec.initContainers || [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            other.spec.initContainers.forEach((container: any) => {
                const exists = mergedPod.spec.initContainers.find((c: { name: string }) => c.name === container.name);
                if (!exists) {
                    mergedPod.spec.initContainers.push(container);
                }
            });
        }

        if (other.spec.volumes) {
            mergedPod.spec.volumes = mergedPod.spec.volumes || [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            other.spec.volumes.forEach((volume: any) => {
                const exists = mergedPod.spec.volumes.find((v: { name: string }) => v.name === volume.name);
                if (!exists) {
                    mergedPod.spec.volumes.push(volume);
                }
            });
        }

        if (other.spec.hostNetwork) {
            mergedPod.spec.hostNetwork = true;
        }
    }

    return mergedPod;
}

async function buildStackPreviewForMerge(
    services: DiscoveredService[],
    newName: string,
    targetPaths: { kube: string; yaml: string },
    executor: Executor
): Promise<PlanDetail> {
    const validations: PlanValidation[] = [];
    const fileMappings: PlanFileMapping[] = [];
    const mappingKeys = new Set<string>();

    services.forEach(service => {
        const source = describeRuntimeSource(service);
        const key = `${source}::${targetPaths.yaml}`;
        if (mappingKeys.has(key)) return;
        mappingKeys.add(key);
        fileMappings.push({ source, action: 'migrate', target: targetPaths.yaml });
    });

    try {
        const podYamls = await collectGeneratedPodSpecs(services, executor);
        const mergedPod = mergePodSpecs(podYamls, newName);
        const stackYaml = yaml.dump(mergedPod);
        validations.push({
            level: 'info',
            message: `Combined ${podYamls.length} pod definition${podYamls.length > 1 ? 's' : ''} into ${newName}`,
            scope: newName
        });
        const dryRunResults = await runDryRunValidation(executor, stackYaml, newName);
        validations.push(...dryRunResults);
        return {
            stackPreview: stackYaml,
            validations,
            fileMappings
        };
    } catch (error) {
        validations.push({
            level: 'error',
            message: (error as Error).message,
            scope: newName
        });
        return {
            stackPreview: STACK_PREVIEW_FALLBACK,
            validations,
            fileMappings
        };
    }
}

async function getMigrationPlan(service: DiscoveredService, customName?: string, connection?: PodmanConnection): Promise<MigrationPlan> {
    const executor = getExecutor(connection);
    const cleanName = customName || service.serviceName.replace('.service', '');
    const systemdDir = getSystemdDir();
    const targetKubePath = path.join(systemdDir, `${cleanName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${cleanName}.yml`);

    const filesToCreate = [targetKubePath, targetYamlPath];
    const filesToBackup: string[] = [];

    // Check if target files already exist
    if (await executor.exists(targetKubePath)) filesToBackup.push(targetKubePath);
    if (await executor.exists(targetYamlPath)) filesToBackup.push(targetYamlPath);

    const planDetails = await buildStackPreviewForService(
        service,
        cleanName,
        { kube: targetKubePath, yaml: targetYamlPath },
        executor
    );

    return {
        filesToCreate,
        filesToBackup,
        servicesToStop: [service.serviceName],
        targetName: cleanName,
        backupDir: getBackupDir(),
        backupArchive: describeArchivePattern(getBackupDir(), cleanName),
        stackPreview: planDetails.stackPreview,
        validations: planDetails.validations,
        fileMappings: planDetails.fileMappings
    };
}

export async function migrateService(service: DiscoveredService, customName?: string, dryRun = false, connection?: PodmanConnection) {
    const executor = getExecutor(connection);
    if (dryRun) {
        return getMigrationPlan(service, customName, connection);
    }

    const systemdDir = getSystemdDir();
    // Ensure directory exists
    if (!await executor.exists(systemdDir)) {
        await executor.mkdir(systemdDir);
    }

    const cleanName = customName || service.serviceName.replace('.service', '');
    const targetKubePath = path.join(systemdDir, `${cleanName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${cleanName}.yml`);
    const backupDir = getBackupDir();

    const backupCandidates: string[] = [];
    if (await executor.exists(targetKubePath)) backupCandidates.push(targetKubePath);
    if (await executor.exists(targetYamlPath)) backupCandidates.push(targetYamlPath);
    await createBackupArchive(executor, backupCandidates, backupDir, cleanName, connection?.Name || 'Local');

    // Perform Backups
    await createBackup(executor, targetKubePath, cleanName, connection);
    await createBackup(executor, targetYamlPath, cleanName, connection);

    // Note: We delay stopping the old service until AFTER we generate the kube/yaml files.
    // This is critical because `podman generate kube` needs the container to exist (and preferably be running),
    // and stopping the service might remove the container or make it inaccessible.

    if (service.type === 'kube' && service.sourcePath) {
        // Case 1: Existing .kube file outside managed dir
        // We need to read it to find the referenced YAML
        const content = await executor.readFile(service.sourcePath);

        // Save source kube content as history for the new kube file
        try {
            await saveSnapshot(path.basename(targetKubePath), content, connection);
        } catch (e) {
            logger.warn('migration', 'Failed to save history snapshot for kube file', e);
        }

        const yamlMatch = content.match(/Yaml=(.+)/);

        if (yamlMatch) {
            const yamlFile = yamlMatch[1].trim();
            const sourceDir = path.dirname(service.sourcePath);
            const sourceYamlPath = path.isAbsolute(yamlFile) ? yamlFile : path.join(sourceDir, yamlFile);

            // Read and modify YAML to ensure Pod name matches Service name
            const yamlContent = await executor.readFile(sourceYamlPath);

            // Save source yaml content as history for the new yaml file
            try {
                await saveSnapshot(path.basename(targetYamlPath), yamlContent, connection);
            } catch (e) {
                logger.warn('migration', 'Failed to save history snapshot for yaml file', e);
            }

            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const doc = yaml.load(yamlContent) as any;
                if (doc) {
                    if (doc.metadata) {
                        doc.metadata.name = sanitizePodName(cleanName);
                    }
                    // Sanitize hostname if present
                    if (doc.spec && doc.spec.hostname) {
                        doc.spec.hostname = sanitizePodName(doc.spec.hostname);
                    }
                    // Sanitize container names
                    if (doc.spec && doc.spec.containers) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        doc.spec.containers.forEach((c: any) => {
                            if (c.name) c.name = sanitizePodName(c.name);
                        });
                    }

                    const modifiedYaml = yaml.dump(doc);
                    await executor.writeFile(targetYamlPath, modifiedYaml);
                } else {
                    await executor.writeFile(targetYamlPath, yamlContent);
                }
            } catch (e) {
                logger.warn('migration', 'Failed to parse/modify source YAML, copying as is', e);
                await executor.writeFile(targetYamlPath, yamlContent);
            }

            // Create new .kube file pointing to new YAML
            const newContent = content.replace(/Yaml=.+/, `Yaml=${cleanName}.yml`);
            await executor.writeFile(targetKubePath, newContent);

            // Now that we have copied the configuration, we can safely stop the old service
            if (service.serviceName && service.serviceName !== `${cleanName}.service`) {
                try {
                    logger.info('migration', `Stopping old service ${service.serviceName}...`);
                    await executor.execArgv(['systemctl', '--user', 'disable', '--now', service.serviceName]);
                } catch (e) {
                    logger.warn('migration', `Failed to stop old service ${service.serviceName}`, e);
                }
            }
        } else {
            // Just copy the kube file if no YAML referenced (unlikely for kube type)
            const content = await executor.readFile(service.sourcePath);
            await executor.writeFile(targetKubePath, content);

            // Now that we have copied the configuration, we can safely stop the old service
            if (service.serviceName && service.serviceName !== `${cleanName}.service`) {
                try {
                    logger.info('migration', `Stopping old service ${service.serviceName}...`);
                    await executor.execArgv(['systemctl', '--user', 'disable', '--now', service.serviceName]);
                } catch (e) {
                    logger.warn('migration', `Failed to stop old service ${service.serviceName}`, e);
                }
            }
        }

    } else if (service.podId || service.containerIds.length > 0) {
        // Case 2: Generate from running Pod or Containers
        const targetIds = service.podId ? service.podId : service.containerIds.join(' ');
        const { stdout } = await executor.execArgv(['podman', 'generate', 'kube', ...targetIds.split(' ').filter(Boolean)]);

        // Inspect to check for runtime flags that might be missed (HostNetwork, Privileged)
        let hostNetwork = false;
        const privilegedContainers = new Set<string>();

        try {
             if (service.podId) {
                 const podInspect = await inspectItem(executor, service.podId, 'pod');
                 if (podInspect && podInspect.InfraContainerID) {
                     const infraInspect = await inspectItem(executor, podInspect.InfraContainerID, 'container');
                     if (infraInspect && infraInspect.HostConfig && infraInspect.HostConfig.NetworkMode === 'host') {
                         hostNetwork = true;
                     }
                 }
                 // Check privileged for containers in pod
                 for (const cid of service.containerIds) {
                     const cInspect = await inspectItem(executor, cid, 'container');
                     if (cInspect && cInspect.HostConfig && cInspect.HostConfig.Privileged) {
                         const name = cInspect.Name.replace(/^\//, '');
                         privilegedContainers.add(name);
                         privilegedContainers.add(sanitizePodName(name));
                     }
                 }
             } else {
                 // Standalone containers
                 for (const cid of service.containerIds) {
                     const cInspect = await inspectItem(executor, cid, 'container');
                     if (cInspect && cInspect.HostConfig) {
                         if (cInspect.HostConfig.NetworkMode === 'host') hostNetwork = true;
                         if (cInspect.HostConfig.Privileged) {
                             const name = cInspect.Name.replace(/^\//, '');
                             privilegedContainers.add(name);
                             privilegedContainers.add(sanitizePodName(name));
                         }
                     }
                 }
             }
        } catch (e) {
            logger.warn('migration', 'Failed to inspect items for runtime config', e);
        }

        // Parse and modify YAML
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = yaml.load(stdout) as any;
            if (doc) {
                if (doc.metadata) {
                    doc.metadata.name = sanitizePodName(cleanName);
                }
                // Sanitize hostname if present
                if (doc.spec && doc.spec.hostname) {
                    doc.spec.hostname = sanitizePodName(doc.spec.hostname);
                }

                // Apply HostNetwork
                if (hostNetwork) {
                    if (!doc.spec) doc.spec = {};
                    doc.spec.hostNetwork = true;
                    if (!doc.spec.dnsPolicy) {
                        doc.spec.dnsPolicy = 'ClusterFirstWithHostNet';
                    }
                }

                // Sanitize container names and apply Privileged
                if (doc.spec && doc.spec.containers) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    doc.spec.containers.forEach((c: any) => {
                        if (c.name) {
                            const oldName = c.name;
                            c.name = sanitizePodName(c.name);

                            if (privilegedContainers.has(oldName) || privilegedContainers.has(c.name)) {
                                if (!c.securityContext) c.securityContext = {};
                                c.securityContext.privileged = true;
                            }
                        }
                    });
                }

                const modifiedYaml = yaml.dump(doc);
                await executor.writeFile(targetYamlPath, modifiedYaml);
            } else {
                await executor.writeFile(targetYamlPath, stdout);
            }
        } catch (e) {
            logger.warn('migration', 'Failed to parse/modify generated YAML, using raw output', e);
            await executor.writeFile(targetYamlPath, stdout);
        }

        // Now that we have generated and written the configuration, we can safely stop the old service
        if (service.serviceName && service.serviceName !== `${cleanName}.service`) {
            try {
                logger.info('migration', `Stopping old service ${service.serviceName}...`);
                await executor.execArgv(['systemctl', '--user', 'disable', '--now', service.serviceName]);
            } catch (e) {
                logger.warn('migration', `Failed to stop old service ${service.serviceName}`, e);
            }
        }

        const kubeBase = `[Unit]
Description=Migrated service ${cleanName}
After=network-online.target

[Kube]
Yaml=${cleanName}.yml
AutoUpdate=registry

[Install]
WantedBy=default.target
`;
        // Apply the shared restart-backoff + start-timeout directives so a
        // migrated service gets the same crash-loop behaviour as a freshly-
        // deployed one (see services/quadletDirectives.ts for the values).
        const kubeContent = injectServiceDirectives(kubeBase);
        await executor.writeFile(targetKubePath, kubeContent);
    } else {
        throw new Error('Cannot migrate: No source file and no Pod/Container ID found');
    }

    // Reload systemd
    await executor.exec('systemctl --user daemon-reload');
}

async function getMergePlan(services: DiscoveredService[], newName: string, connection?: PodmanConnection): Promise<MigrationPlan> {
    const executor = getExecutor(connection);
    const systemdDir = getSystemdDir();
    const targetKubePath = path.join(systemdDir, `${newName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${newName}.yml`);

    const filesToCreate = [targetKubePath, targetYamlPath];
    const filesToBackup: string[] = [];

    // Check if target files already exist
    if (await executor.exists(targetKubePath)) filesToBackup.push(targetKubePath);
    if (await executor.exists(targetYamlPath)) filesToBackup.push(targetYamlPath);

    const planDetails = await buildStackPreviewForMerge(
        services,
        newName,
        { kube: targetKubePath, yaml: targetYamlPath },
        executor
    );

    return {
        filesToCreate,
        filesToBackup,
        servicesToStop: services.map(s => s.serviceName),
        targetName: newName,
        backupDir: getBackupDir(),
        backupArchive: describeArchivePattern(getBackupDir(), newName),
        stackPreview: planDetails.stackPreview,
        validations: planDetails.validations,
        fileMappings: planDetails.fileMappings
    };
}

export async function mergeServices(services: DiscoveredService[], newName: string, options: MergeOptions = {}) {
    const { dryRun = false, connection, initiator } = options;
    const executor = getExecutor(connection);
    if (dryRun) {
        return getMergePlan(services, newName, connection);
    }

    const systemdDir = getSystemdDir();
    if (!await executor.exists(systemdDir)) {
        await executor.mkdir(systemdDir);
    }

    const targetKubePath = path.join(systemdDir, `${newName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${newName}.yml`);
    const backupDir = getBackupDir();
    const nodeName = connection?.Name || 'Local';

    const backupCandidates = collectBackupCandidates(services, [targetKubePath, targetYamlPath]);
    const backupArchive = await createBackupArchive(executor, backupCandidates, backupDir, newName, nodeName);

    await createBackup(executor, targetKubePath, newName, connection);
    await createBackup(executor, targetYamlPath, newName, connection);

    const podYamls = await collectGeneratedPodSpecs(services, executor);
    for (const doc of podYamls) {
        try {
            const content = yaml.dump(doc);
            await saveSnapshot(`${newName}.yml`, content, connection);
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
            logger.warn('migration', 'Failed to save history snapshot', e);
        }
    }

    const mergedPod = mergePodSpecs(podYamls, newName);
    const finalYaml = yaml.dump(mergedPod);
    await executor.writeFile(targetYamlPath, finalYaml);

    const kubeContent = `[Unit]
Description=Merged service ${newName}
After=network-online.target

[Kube]
Yaml=${newName}.yml
AutoUpdate=registry

[Install]
WantedBy=default.target
`;
    await executor.writeFile(targetKubePath, kubeContent);

    await activateMergedUnit({ executor, services, newName, nodeName, backupArchive, initiator });
}

/**
 * Stop the legacy units, enable the merged unit, and roll back if the
 * new unit fails to come up healthy. Records the outcome (success /
 * rolled_back / failed) in the migration history. Re-throws the
 * original activation error after recording so the caller still sees
 * the failure.
 */
async function activateMergedUnit(params: {
    executor: Executor;
    services: DiscoveredService[];
    newName: string;
    nodeName: string;
    backupArchive?: string;
    initiator?: string;
}): Promise<void> {
    const { executor, services, newName, nodeName, backupArchive, initiator } = params;
    const stoppedServices = await stopLegacyServices(executor, services);
    const targetUnit = `${newName}.service`;

    try {
        await executor.exec('systemctl --user daemon-reload');
        await executor.execArgv(['systemctl', '--user', 'enable', '--now', targetUnit]);
        await waitForServiceHealthy(executor, targetUnit);
        recordMigrationHistory({
            status: 'success',
            targetName: newName,
            nodeName,
            services,
            actor: initiator,
            backupArchive
        });
    } catch (error) {
        const rollbackSucceeded = await rollbackManagedService({
            executor,
            targetUnit,
            archivePath: backupArchive,
            stoppedServices
        });
        recordMigrationHistory({
            status: rollbackSucceeded ? 'rolled_back' : 'failed',
            targetName: newName,
            nodeName,
            services,
            actor: initiator,
            backupArchive,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}
