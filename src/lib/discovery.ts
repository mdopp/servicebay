import { getPodmanPs } from './manager';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);
const SYSTEMD_DIR = path.join(os.homedir(), '.config/containers/systemd');

export interface DiscoveredService {
    serviceName: string;
    containerNames: string[];
    podId?: string;
    unitFile?: string;
    sourcePath?: string;
    status: 'managed' | 'unmanaged';
    type: 'kube' | 'container' | 'pod' | 'compose' | 'other';
}

export async function discoverSystemdServices(): Promise<DiscoveredService[]> {
    const containers = await getPodmanPs();
    const servicesMap = new Map<string, { names: string[], podId?: string }>();

    // Group containers by systemd unit
    for (const container of containers) {
        const unit = container.Labels?.['PODMAN_SYSTEMD_UNIT'];
        if (unit) {
            const current: { names: string[], podId?: string } = servicesMap.get(unit) || { names: [], podId: container.Pod };
            // Clean up container name
            const name = container.Names && container.Names.length > 0 ? container.Names[0].replace(/^\//, '') : container.Id.substring(0, 12);
            
            current.names.push(name);
            
            servicesMap.set(unit, current);
        }
    }

    const results: DiscoveredService[] = [];

    for (const [serviceName, data] of servicesMap.entries()) {
        const containerNames = data.names;
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
            podId,
            unitFile,
            sourcePath,
            status,
            type
        });
    }

    return results;
}

import fs from 'fs/promises';

export async function migrateService(service: DiscoveredService) {
    // Ensure directory exists
    try {
        await fs.access(SYSTEMD_DIR);
    } catch {
        await fs.mkdir(SYSTEMD_DIR, { recursive: true });
    }

    const cleanName = service.serviceName.replace('.service', '');
    const targetKubePath = path.join(SYSTEMD_DIR, `${cleanName}.kube`);
    const targetYamlPath = path.join(SYSTEMD_DIR, `${cleanName}.yml`);

    if (service.type === 'kube' && service.sourcePath) {
        // Case 1: Existing .kube file outside managed dir
        // We need to read it to find the referenced YAML
        const content = await fs.readFile(service.sourcePath, 'utf-8');
        const yamlMatch = content.match(/Yaml=(.+)/);
        
        if (yamlMatch) {
            const yamlFile = yamlMatch[1].trim();
            const sourceDir = path.dirname(service.sourcePath);
            const sourceYamlPath = path.isAbsolute(yamlFile) ? yamlFile : path.join(sourceDir, yamlFile);
            
            // Copy YAML
            await fs.copyFile(sourceYamlPath, targetYamlPath);
            
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
        await fs.writeFile(targetYamlPath, stdout);

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
    
    // We don't start it yet, user should do that? 
    // Or maybe we should enable it?
    // If we enable it, it might conflict with the existing running service if we don't stop it.
    // But the existing service IS the one we just migrated (if it was a file).
    // If it was a generated service, we are replacing it.
    
    // For safety, let's just reload. The user can then "Start" it from the dashboard.
}
