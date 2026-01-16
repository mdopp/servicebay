import { getPodmanPs } from './manager';
import { getExecutor, Executor } from './executor';
import { PodmanConnection } from './nodes';
import path from 'path';
import yaml from 'js-yaml';
import os from 'os';

function getSystemdDir(connection?: PodmanConnection) {
    if (connection) {
        return '.config/containers/systemd';
    }
    return path.join(os.homedir(), '.config/containers/systemd');
}

function getBackupDir(connection?: PodmanConnection) {
    return path.join(getSystemdDir(connection), 'backups');
}

async function inspectItem(executor: Executor, id: string, type: 'container' | 'pod' = 'container') {
    try {
        const { stdout } = await executor.exec(`podman inspect ${type === 'pod' ? '--type pod' : '--type container'} ${id}`);
        const data = JSON.parse(stdout);
        return Array.isArray(data) ? data[0] : data;
    } catch (e) {
        console.warn(`Failed to inspect ${type} ${id}`, e);
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
}

export async function discoverSystemdServices(connection?: PodmanConnection): Promise<DiscoveredService[]> {
    if (!connection) {
        return [];
    }
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



import { saveSnapshot } from './history';

interface MigrationPlan {
    filesToCreate: string[];
    filesToBackup: string[];
    servicesToStop: string[];
    targetName: string;
    backupDir: string;
}


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

function sanitizePodName(name: string): string {
    // Kubernetes Pod names must consist of lower case alphanumeric characters, '-' or '.', 
    // and must start and end with an alphanumeric character.
    return name.toLowerCase()
        .replace(/[^a-z0-9-.]/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function getMigrationPlan(service: DiscoveredService, customName?: string, connection?: PodmanConnection): Promise<MigrationPlan> {
    const executor = getExecutor(connection);
    const cleanName = customName || service.serviceName.replace('.service', '');
    const systemdDir = getSystemdDir(connection);
    const targetKubePath = path.join(systemdDir, `${cleanName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${cleanName}.yml`);

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
        backupDir: getBackupDir(connection)
    };
}

export async function migrateService(service: DiscoveredService, customName?: string, dryRun = false, connection?: PodmanConnection) {
    const executor = getExecutor(connection);
    if (dryRun) {
        return getMigrationPlan(service, customName, connection);
    }

    const systemdDir = getSystemdDir(connection);
    // Ensure directory exists
    if (!await executor.exists(systemdDir)) {
        await executor.mkdir(systemdDir);
    }

    const cleanName = customName || service.serviceName.replace('.service', '');
    const targetKubePath = path.join(systemdDir, `${cleanName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${cleanName}.yml`);

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
            console.warn('Failed to save history snapshot for kube file', e);
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
                console.warn('Failed to save history snapshot for yaml file', e);
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
                console.warn('Failed to parse/modify source YAML, copying as is', e);
                await executor.writeFile(targetYamlPath, yamlContent);
            }
            
            // Create new .kube file pointing to new YAML
            const newContent = content.replace(/Yaml=.+/, `Yaml=${cleanName}.yml`);
            await executor.writeFile(targetKubePath, newContent);

            // Now that we have copied the configuration, we can safely stop the old service
            if (service.serviceName && service.serviceName !== `${cleanName}.service`) {
                try {
                    console.log(`Stopping old service ${service.serviceName}...`);
                    await executor.exec(`systemctl --user disable --now ${service.serviceName}`);
                } catch (e) {
                    console.warn(`Failed to stop old service ${service.serviceName}`, e);
                }
            }
        } else {
            // Just copy the kube file if no YAML referenced (unlikely for kube type)
            const content = await executor.readFile(service.sourcePath);
            await executor.writeFile(targetKubePath, content);

            // Now that we have copied the configuration, we can safely stop the old service
            if (service.serviceName && service.serviceName !== `${cleanName}.service`) {
                try {
                    console.log(`Stopping old service ${service.serviceName}...`);
                    await executor.exec(`systemctl --user disable --now ${service.serviceName}`);
                } catch (e) {
                    console.warn(`Failed to stop old service ${service.serviceName}`, e);
                }
            }
        }

    } else if (service.podId || service.containerIds.length > 0) {
        // Case 2: Generate from running Pod or Containers
        const targetIds = service.podId ? service.podId : service.containerIds.join(' ');
        const { stdout } = await executor.exec(`podman generate kube ${targetIds}`);
        
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
            console.warn('Failed to inspect items for runtime config', e);
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
            console.warn('Failed to parse/modify generated YAML, using raw output', e);
            await executor.writeFile(targetYamlPath, stdout);
        }

        // Now that we have generated and written the configuration, we can safely stop the old service
        if (service.serviceName && service.serviceName !== `${cleanName}.service`) {
            try {
                console.log(`Stopping old service ${service.serviceName}...`);
                await executor.exec(`systemctl --user disable --now ${service.serviceName}`);
            } catch (e) {
                console.warn(`Failed to stop old service ${service.serviceName}`, e);
            }
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
        throw new Error('Cannot migrate: No source file and no Pod/Container ID found');
    }

    // Reload systemd
    await executor.exec('systemctl --user daemon-reload');
}

async function getMergePlan(services: DiscoveredService[], newName: string, connection?: PodmanConnection): Promise<MigrationPlan> {
    const executor = getExecutor(connection);
    const systemdDir = getSystemdDir(connection);
    const targetKubePath = path.join(systemdDir, `${newName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${newName}.yml`);

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
        backupDir: getBackupDir(connection)
    };
}

export async function mergeServices(services: DiscoveredService[], newName: string, dryRun = false, connection?: PodmanConnection) {
    const executor = getExecutor(connection);
    if (dryRun) {
        return getMergePlan(services, newName, connection);
    }

    const systemdDir = getSystemdDir(connection);
    // Ensure directory exists
    if (!await executor.exists(systemdDir)) {
        await executor.mkdir(systemdDir);
    }

    const targetKubePath = path.join(systemdDir, `${newName}.kube`);
    const targetYamlPath = path.join(systemdDir, `${newName}.yml`);

    // Perform Backups
    await createBackup(executor, targetKubePath, newName, connection);
    await createBackup(executor, targetYamlPath, newName, connection);

    // Collect all Pod YAMLs and merge them
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const podYamls: any[] = [];
    const processedPodIds = new Set<string>();
    const standaloneContainerIds: string[] = [];

    for (const service of services) {
        if (service.podId) {
            if (processedPodIds.has(service.podId)) {
                continue;
            }
            processedPodIds.add(service.podId);
            
            try {
                const { stdout } = await executor.exec(`podman generate kube ${service.podId}`);
                const doc = yaml.load(stdout);
                podYamls.push(doc);
            } catch (e) {
                console.warn(`Failed to generate kube for pod ${service.podId}`, e);
                throw e;
            }
        } else if (service.containerIds.length > 0) {
            standaloneContainerIds.push(...service.containerIds);
        }
    }

    if (standaloneContainerIds.length > 0) {
        try {
            const { stdout } = await executor.exec(`podman generate kube ${standaloneContainerIds.join(' ')}`);
            const doc = yaml.load(stdout);
            podYamls.push(doc);
        } catch (e) {
            console.warn('Failed to generate kube for standalone containers', e);
            throw e;
        }
    }

    if (podYamls.length === 0) {
        throw new Error('Failed to generate any YAMLs');
    }

    // Save source YAMLs as history snapshots for the new service
    // This allows the user to see/revert to the original components
    for (const doc of podYamls) {
        try {
            const content = yaml.dump(doc);
            // We use the target YAML filename as the key for history
            await saveSnapshot(`${newName}.yml`, content, connection);
            // Small delay to ensure unique timestamps if system clock resolution is low
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
            console.warn('Failed to save history snapshot', e);
        }
    }

    // Merge Logic
    // Use the first one as base
     
    const mergedPod = podYamls[0];
    mergedPod.metadata.name = newName;
    // Reset creationTimestamp etc
    if (mergedPod.metadata) {
        delete mergedPod.metadata.creationTimestamp;
    }
    delete mergedPod.status;

    for (let i = 1; i < podYamls.length; i++) {
        const other = podYamls[i];
        
        // Merge Containers
        if (other.spec.containers) {
             
            for (const container of other.spec.containers) {
                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                 const exists = mergedPod.spec.containers.find((c: any) => c.name === container.name);
                 if (!exists) {
                     mergedPod.spec.containers.push(container);
                 }
            }
        }
        
        // Merge InitContainers
        if (other.spec.initContainers) {
            mergedPod.spec.initContainers = mergedPod.spec.initContainers || [];
             
            for (const container of other.spec.initContainers) {
                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                 const exists = mergedPod.spec.initContainers.find((c: any) => c.name === container.name);
                 if (!exists) {
                     mergedPod.spec.initContainers.push(container);
                 }
            }
        }

        // Merge Volumes
        if (other.spec.volumes) {
            mergedPod.spec.volumes = mergedPod.spec.volumes || [];
            // Deduplicate volumes by name
             
            for (const vol of other.spec.volumes) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const exists = mergedPod.spec.volumes.find((v: any) => v.name === vol.name);
                if (!exists) {
                    mergedPod.spec.volumes.push(vol);
                }
            }
        }

        // Merge HostNetwork (if any is true, set to true)
        if (other.spec.hostNetwork) {
            mergedPod.spec.hostNetwork = true;
        }
    }

    const finalYaml = yaml.dump(mergedPod);
    await executor.writeFile(targetYamlPath, finalYaml);

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
