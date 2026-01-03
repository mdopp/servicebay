import { getPodmanPs } from './manager';
import { getExecutor, Executor } from './executor';
import { PodmanConnection } from './nodes';
import path from 'path';
import yaml from 'js-yaml';

const SYSTEMD_DIR = '.config/containers/systemd';
const BACKUP_DIR = `${SYSTEMD_DIR}/backups`;

export interface DiscoveredService {
    serviceName: string;
    containerNames: string[];
    containerIds: string[];
    podId?: string;
    unitFile?: string;
    sourcePath?: string;
    status: 'managed' | 'unmanaged';
    type: 'kube' | 'container' | 'pod' | 'compose' | 'other';
}

export async function discoverSystemdServices(connection?: PodmanConnection): Promise<DiscoveredService[]> {
    const executor = getExecutor(connection);
    const containers = await getPodmanPs(connection);
    const servicesMap = new Map<string, { names: string[], ids: string[], podId?: string }>();

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

        try {
            const { stdout } = await executor.exec(`systemctl --user show -p FragmentPath -p SourcePath ${serviceName}`);
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.startsWith('FragmentPath=')) unitFile = line.substring(13);
                if (line.startsWith('SourcePath=')) sourcePath = line.substring(11);
            }
        } catch (e) {
            console.error(`Failed to inspect service ${serviceName}`, e);
        }

        // Determine Type
        if (serviceName.includes('podman-compose')) {
            type = 'compose';
        } else if (sourcePath) {
             if (sourcePath.endsWith('.kube')) type = 'kube';
             else if (sourcePath.endsWith('.container')) type = 'container';
             else if (sourcePath.endsWith('.pod')) type = 'pod';
        }

        // Determine Status (Managed by PodCLI?)
        // PodCLI currently manages .kube files in the SYSTEMD_DIR
        // We need to check if sourcePath is within SYSTEMD_DIR
        // Since paths might be absolute or relative, and we are remote, this is tricky.
        // But usually SYSTEMD_DIR is ~/.config/containers/systemd
        
        if (type === 'kube' && sourcePath && sourcePath.includes('.config/containers/systemd')) {
            status = 'managed';
        }

        // Filter out empty paths if they are empty strings
        if (!unitFile) unitFile = undefined;
        if (!sourcePath) sourcePath = undefined;

        results.push({
            serviceName,
            containerNames,
            containerIds,
            podId,
            unitFile,
            sourcePath,
            status,
            type
        });
    }

    return results;
}



export interface MigrationPlan {
    filesToCreate: string[];
    filesToBackup: string[];
    servicesToStop: string[];
    targetName: string;
    backupDir: string;
}


async function createBackup(executor: Executor, filePath: string, serviceName: string) {
    if (!await executor.exists(filePath)) {
        return; // File doesn't exist, nothing to backup
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(BACKUP_DIR, `${timestamp}_${serviceName}`);
    await executor.mkdir(backupDir);
    
    const fileName = path.basename(filePath);
    const content = await executor.readFile(filePath);
    await executor.writeFile(path.join(backupDir, fileName), content);
}

export async function getMigrationPlan(service: DiscoveredService, customName?: string, connection?: PodmanConnection): Promise<MigrationPlan> {
    const executor = getExecutor(connection);
    const cleanName = customName || service.serviceName.replace('.service', '');
    const targetKubePath = path.join(SYSTEMD_DIR, `${cleanName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${cleanName}.yml`);

    const filesToCreate = [targetKubePath, targetYamlPath];
    const filesToBackup: string[] = [];
    
    // Check if target files already exist
    if (await executor.exists(targetKubePath)) filesToBackup.push(targetKubePath);
    if (await executor.exists(targetYamlPath)) filesToBackup.push(targetYamlPath);

    return {
        filesToCreate,
        filesToBackup,
        servicesToStop: [service.serviceName],
        targetName: cleanName,
        backupDir: BACKUP_DIR
    };
}

export async function migrateService(service: DiscoveredService, customName?: string, dryRun = false, connection?: PodmanConnection) {
    const executor = getExecutor(connection);
    if (dryRun) {
        return getMigrationPlan(service, customName, connection);
    }

    // Ensure directory exists
    if (!await executor.exists(SYSTEMD_DIR)) {
        await executor.mkdir(SYSTEMD_DIR);
    }

    const cleanName = customName || service.serviceName.replace('.service', '');
    const targetKubePath = path.join(SYSTEMD_DIR, `${cleanName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${cleanName}.yml`);

    // Perform Backups
    await createBackup(executor, targetKubePath, cleanName);
    await createBackup(executor, targetYamlPath, cleanName);

    if (service.type === 'kube' && service.sourcePath) {
        // Case 1: Existing .kube file outside managed dir
        // We need to read it to find the referenced YAML
        const content = await executor.readFile(service.sourcePath);
        const yamlMatch = content.match(/Yaml=(.+)/);
        
        if (yamlMatch) {
            const yamlFile = yamlMatch[1].trim();
            const sourceDir = path.dirname(service.sourcePath);
            const sourceYamlPath = path.isAbsolute(yamlFile) ? yamlFile : path.join(sourceDir, yamlFile);
            
            // Read and modify YAML to ensure Pod name matches Service name
            const yamlContent = await executor.readFile(sourceYamlPath);
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const doc = yaml.load(yamlContent) as any;
                if (doc && doc.metadata) {
                    doc.metadata.name = cleanName;
                    const modifiedYaml = yaml.dump(doc);
                    await executor.writeFile(targetYamlPath, modifiedYaml);
                } else {
                    await executor.writeFile(targetYamlPath, yamlContent);
                }
            } catch (e) {
                console.warn('Failed to parse/modify source YAML, copying as is', e);
                await executor.writeFile(targetYamlPath, yamlContent);
            }
            
            // Create new .kube file pointing to new YAML
            const newContent = content.replace(/Yaml=.+/, `Yaml=${cleanName}.yml`);
            await executor.writeFile(targetKubePath, newContent);
        } else {
            // Just copy the kube file if no YAML referenced (unlikely for kube type)
            const content = await executor.readFile(service.sourcePath);
            await executor.writeFile(targetKubePath, content);
        }

    } else if (service.podId) {
        // Case 2: Generate from running Pod
        const { stdout } = await executor.exec(`podman generate kube ${service.podId}`);
        
        // Parse and modify YAML to ensure Pod name matches Service name
        // This is crucial for the Network Map association logic
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = yaml.load(stdout) as any;
            if (doc && doc.metadata) {
                doc.metadata.name = cleanName;
                // Also ensure containers have unique names if needed, but Pod name is most important
                const modifiedYaml = yaml.dump(doc);
                await executor.writeFile(targetYamlPath, modifiedYaml);
            } else {
                await executor.writeFile(targetYamlPath, stdout);
            }
        } catch (e) {
            console.warn('Failed to parse/modify generated YAML, using raw output', e);
            await executor.writeFile(targetYamlPath, stdout);
        }

        const kubeContent = `[Unit]
Description=Migrated service ${cleanName}
After=network-online.target

[Kube]
Yaml=${cleanName}.yml
AutoUpdate=registry

[Install]
WantedBy=default.target
`;
        await executor.writeFile(targetKubePath, kubeContent);
    } else {
        throw new Error('Cannot migrate: No source file and no Pod ID found');
    }

    // Reload systemd
    await executor.exec('systemctl --user daemon-reload');
}

export async function getMergePlan(services: DiscoveredService[], newName: string, connection?: PodmanConnection): Promise<MigrationPlan> {
    const executor = getExecutor(connection);
    const targetKubePath = path.join(SYSTEMD_DIR, `${newName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${newName}.yml`);

    const filesToCreate = [targetKubePath, targetYamlPath];
    const filesToBackup: string[] = [];
    
    // Check if target files already exist
    if (await executor.exists(targetKubePath)) filesToBackup.push(targetKubePath);
    if (await executor.exists(targetYamlPath)) filesToBackup.push(targetYamlPath);

    return {
        filesToCreate,
        filesToBackup,
        servicesToStop: services.map(s => s.serviceName),
        targetName: newName,
        backupDir: BACKUP_DIR
    };
}

export async function mergeServices(services: DiscoveredService[], newName: string, dryRun = false, connection?: PodmanConnection) {
    const executor = getExecutor(connection);
    if (dryRun) {
        return getMergePlan(services, newName, connection);
    }

    // Ensure directory exists
    if (!await executor.exists(SYSTEMD_DIR)) {
        await executor.mkdir(SYSTEMD_DIR);
    }

    const targetKubePath = path.join(SYSTEMD_DIR, `${newName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${newName}.yml`);

    // Perform Backups
    await createBackup(executor, targetKubePath, newName);
    await createBackup(executor, targetYamlPath, newName);

    // Collect all container IDs
    const containerIds = services.flatMap(s => s.containerIds);
    
    if (containerIds.length === 0) {
        throw new Error('No containers found to merge');
    }

    // Generate Kube YAML from all containers
    const { stdout } = await executor.exec(`podman generate kube ${containerIds.join(' ')}`);

    // Parse and modify YAML to ensure Pod name matches new Service name
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = yaml.load(stdout) as any;
        if (doc && doc.metadata) {
            doc.metadata.name = newName;
            const modifiedYaml = yaml.dump(doc);
            await executor.writeFile(targetYamlPath, modifiedYaml);
        } else {
            await executor.writeFile(targetYamlPath, stdout);
        }
    } catch (e) {
        console.warn('Failed to parse/modify generated YAML, using raw output', e);
        await executor.writeFile(targetYamlPath, stdout);
    }

    // Create .kube file
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

    // Stop and Disable old services
    for (const service of services) {
        try {
            console.log(`Stopping old service ${service.serviceName}...`);
            await executor.exec(`systemctl --user disable --now ${service.serviceName}`);
        } catch (e) {
            console.warn(`Failed to stop service ${service.serviceName}`, e);
        }
    }

    // Reload systemd
    await executor.exec('systemctl --user daemon-reload');
}
