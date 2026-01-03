import { getPodmanPs } from './manager';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

const execAsync = promisify(exec);
const SYSTEMD_DIR = path.join(os.homedir(), '.config/containers/systemd');
const BACKUP_DIR = path.join(SYSTEMD_DIR, 'backups');

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

export async function discoverSystemdServices(): Promise<DiscoveredService[]> {
    const containers = await getPodmanPs();
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
            const { stdout } = await execAsync(`systemctl --user show -p FragmentPath -p SourcePath ${serviceName}`);
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
        if (type === 'kube' && sourcePath && sourcePath.startsWith(SYSTEMD_DIR)) {
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

async function createBackup(filePath: string, serviceName: string) {
    try {
        await fs.access(filePath);
    } catch {
        return; // File doesn't exist, nothing to backup
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(BACKUP_DIR, `${timestamp}_${serviceName}`);
    await fs.mkdir(backupDir, { recursive: true });
    
    const fileName = path.basename(filePath);
    await fs.copyFile(filePath, path.join(backupDir, fileName));
}

export async function getMigrationPlan(service: DiscoveredService, customName?: string): Promise<MigrationPlan> {
    const cleanName = customName || service.serviceName.replace('.service', '');
    const targetKubePath = path.join(SYSTEMD_DIR, `${cleanName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${cleanName}.yml`);

    const filesToCreate = [targetKubePath, targetYamlPath];
    const filesToBackup: string[] = [];
    
    // Check if target files already exist
    try { await fs.access(targetKubePath); filesToBackup.push(targetKubePath); } catch {}
    try { await fs.access(targetYamlPath); filesToBackup.push(targetYamlPath); } catch {}

    return {
        filesToCreate,
        filesToBackup,
        servicesToStop: [service.serviceName],
        targetName: cleanName,
        backupDir: BACKUP_DIR
    };
}

export async function migrateService(service: DiscoveredService, customName?: string, dryRun = false) {
    if (dryRun) {
        return getMigrationPlan(service, customName);
    }

    // Ensure directory exists
    try {
        await fs.access(SYSTEMD_DIR);
    } catch {
        await fs.mkdir(SYSTEMD_DIR, { recursive: true });
    }

    const cleanName = customName || service.serviceName.replace('.service', '');
    const targetKubePath = path.join(SYSTEMD_DIR, `${cleanName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${cleanName}.yml`);

    // Perform Backups
    await createBackup(targetKubePath, cleanName);
    await createBackup(targetYamlPath, cleanName);

    if (service.type === 'kube' && service.sourcePath) {
        // Case 1: Existing .kube file outside managed dir
        // We need to read it to find the referenced YAML
        const content = await fs.readFile(service.sourcePath, 'utf-8');
        const yamlMatch = content.match(/Yaml=(.+)/);
        
        if (yamlMatch) {
            const yamlFile = yamlMatch[1].trim();
            const sourceDir = path.dirname(service.sourcePath);
            const sourceYamlPath = path.isAbsolute(yamlFile) ? yamlFile : path.join(sourceDir, yamlFile);
            
            // Read and modify YAML to ensure Pod name matches Service name
            const yamlContent = await fs.readFile(sourceYamlPath, 'utf-8');
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const doc = yaml.load(yamlContent) as any;
                if (doc && doc.metadata) {
                    doc.metadata.name = cleanName;
                    const modifiedYaml = yaml.dump(doc);
                    await fs.writeFile(targetYamlPath, modifiedYaml);
                } else {
                    await fs.writeFile(targetYamlPath, yamlContent);
                }
            } catch (e) {
                console.warn('Failed to parse/modify source YAML, copying as is', e);
                await fs.writeFile(targetYamlPath, yamlContent);
            }
            
            // Create new .kube file pointing to new YAML
            const newContent = content.replace(/Yaml=.+/, `Yaml=${cleanName}.yml`);
            await fs.writeFile(targetKubePath, newContent);
        } else {
            // Just copy the kube file if no YAML referenced (unlikely for kube type)
            await fs.copyFile(service.sourcePath, targetKubePath);
        }

    } else if (service.podId) {
        // Case 2: Generate from running Pod
        const { stdout } = await execAsync(`podman generate kube ${service.podId}`);
        
        // Parse and modify YAML to ensure Pod name matches Service name
        // This is crucial for the Network Map association logic
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = yaml.load(stdout) as any;
            if (doc && doc.metadata) {
                doc.metadata.name = cleanName;
                // Also ensure containers have unique names if needed, but Pod name is most important
                const modifiedYaml = yaml.dump(doc);
                await fs.writeFile(targetYamlPath, modifiedYaml);
            } else {
                await fs.writeFile(targetYamlPath, stdout);
            }
        } catch (e) {
            console.warn('Failed to parse/modify generated YAML, using raw output', e);
            await fs.writeFile(targetYamlPath, stdout);
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
        await fs.writeFile(targetKubePath, kubeContent);
    } else {
        throw new Error('Cannot migrate: No source file and no Pod ID found');
    }

    // Reload systemd
    await execAsync('systemctl --user daemon-reload');
}

export async function getMergePlan(services: DiscoveredService[], newName: string): Promise<MigrationPlan> {
    const targetKubePath = path.join(SYSTEMD_DIR, `${newName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${newName}.yml`);

    const filesToCreate = [targetKubePath, targetYamlPath];
    const filesToBackup: string[] = [];
    
    // Check if target files already exist
    try { await fs.access(targetKubePath); filesToBackup.push(targetKubePath); } catch {}
    try { await fs.access(targetYamlPath); filesToBackup.push(targetYamlPath); } catch {}

    return {
        filesToCreate,
        filesToBackup,
        servicesToStop: services.map(s => s.serviceName),
        targetName: newName,
        backupDir: BACKUP_DIR
    };
}

export async function mergeServices(services: DiscoveredService[], newName: string, dryRun = false) {
    if (dryRun) {
        return getMergePlan(services, newName);
    }

    // Ensure directory exists
    try {
        await fs.access(SYSTEMD_DIR);
    } catch {
        await fs.mkdir(SYSTEMD_DIR, { recursive: true });
    }

    const targetKubePath = path.join(SYSTEMD_DIR, `${newName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${newName}.yml`);

    // Perform Backups
    await createBackup(targetKubePath, newName);
    await createBackup(targetYamlPath, newName);

    // Collect all container IDs
    const containerIds = services.flatMap(s => s.containerIds);
    
    if (containerIds.length === 0) {
        throw new Error('No containers found to merge');
    }

    // Generate Kube YAML from all containers
    const { stdout } = await execAsync(`podman generate kube ${containerIds.join(' ')}`);

    // Parse and modify YAML to ensure Pod name matches new Service name
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = yaml.load(stdout) as any;
        if (doc && doc.metadata) {
            doc.metadata.name = newName;
            const modifiedYaml = yaml.dump(doc);
            await fs.writeFile(targetYamlPath, modifiedYaml);
        } else {
            await fs.writeFile(targetYamlPath, stdout);
        }
    } catch (e) {
        console.warn('Failed to parse/modify generated YAML, using raw output', e);
        await fs.writeFile(targetYamlPath, stdout);
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
    await fs.writeFile(targetKubePath, kubeContent);

    // Stop and Disable old services
    for (const service of services) {
        try {
            console.log(`Stopping old service ${service.serviceName}...`);
            await execAsync(`systemctl --user disable --now ${service.serviceName}`);
        } catch (e) {
            console.warn(`Failed to stop service ${service.serviceName}`, e);
        }
    }

    // Reload systemd
    await execAsync('systemctl --user daemon-reload');
}
