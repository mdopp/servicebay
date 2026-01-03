/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { getExecutor, Executor } from './executor';
import { PodmanConnection } from './nodes';

// We assume standard paths for now. In a real remote scenario, we might need to discover these.
// For SSH connections, we assume the user is the same, so paths are relative to their home.
// But wait, os.homedir() returns the container's home dir.
// We need a way to get the remote home dir.
// For now, let's assume ~/.config/containers/systemd is the standard.
const SYSTEMD_DIR = '.config/containers/systemd';

export interface ServiceInfo {
  name: string;
  kubeFile: string;
  kubePath: string;
  yamlFile: string | null;
  yamlPath: string | null;
  active: boolean;
  status: string;
  description?: string;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  labels: Record<string, string>;
  hostNetwork?: boolean;
  node?: string; // Added node name
}

export async function listServices(connection?: PodmanConnection): Promise<ServiceInfo[]> {
  const executor = getExecutor(connection);
  
  // Resolve home dir on remote if needed, but using relative path from home is safer for SSH
  // `ls .config/containers/systemd` works if we are in home.
  // SSH usually lands in home.
  
  try {
    if (!(await executor.exists(SYSTEMD_DIR))) {
        await executor.mkdir(SYSTEMD_DIR);
    }
  } catch (e) {
      console.error('Failed to access systemd dir', e);
      return [];
  }

  let files: string[] = [];
  try {
      files = await executor.readdir(SYSTEMD_DIR);
  } catch (e) {
      console.error('Failed to read systemd dir', e);
      return [];
  }

  const kubeFiles = files.filter(f => f.endsWith('.kube'));
  const services: ServiceInfo[] = [];

  for (const kubeFile of kubeFiles) {
    const name = kubeFile.replace('.kube', '');
    const kubePath = path.join(SYSTEMD_DIR, kubeFile);
    
    let content = '';
    try {
        content = await executor.readFile(kubePath);
    } catch (e) {
        console.error(`Failed to read ${kubePath}`, e);
        continue;
    }
    
    // Extract Yaml file name from [Kube] section
    const yamlMatch = content.match(/Yaml=(.+)/);
    const yamlFile = yamlMatch ? yamlMatch[1].trim() : null;
    
    let yamlPath = null;
    if (yamlFile) {
        // If absolute, use it. If relative, join with SYSTEMD_DIR
        // Note: path.join uses local OS separator. For SSH (Linux), we should force forward slashes.
        if (yamlFile.startsWith('/')) {
            yamlPath = yamlFile;
        } else {
            yamlPath = `${SYSTEMD_DIR}/${yamlFile}`;
        }
    }

    let active = false;
    let status = 'unknown';
    let description = '';
    const ports: { host?: string; container: string }[] = [];
    const volumes: { host: string; container: string }[] = [];
    let labels: Record<string, string> = {};
    let hostNetwork = false;

    try {
      const { stdout } = await executor.exec(`systemctl --user is-active ${name}.service`);
      status = stdout.trim();
      active = status === 'active';
    } catch (e) {
      status = 'inactive';
    }

    try {
      // Get Description
      const { stdout: descStdout } = await executor.exec(`systemctl --user show -p Description --value ${name}.service`);
      description = descStdout.trim();
    } catch (e) {
      // console.warn(`Failed to get description for ${name}`, e);
    }

    // Fallback: If systemd description is empty (e.g. unit not loaded yet), try to parse from .kube file
    if (!description && content) {
        const match = content.match(/Description=(.+)/);
        if (match) {
            description = match[1].trim();
        }
    }

    if (yamlPath) {
        try {
            const yamlContent = await executor.readFile(yamlPath);
            // Handle multi-document YAML files
            const documents = yaml.loadAll(yamlContent) as any[];
            
            // Iterate through all documents to find one with spec.containers
            documents.forEach((parsed) => {
                if (parsed) {
                    // Extract Labels
                    if (parsed.metadata && parsed.metadata.labels) {
                        labels = { ...labels, ...parsed.metadata.labels };
                    }

                    if (parsed.spec) {
                        if (parsed.spec.hostNetwork) {
                            hostNetwork = true;
                        }

                        // Extract Ports
                        if (parsed.spec.containers) {
                            parsed.spec.containers.forEach((container: any) => {
                                if (container.ports) {
                                    container.ports.forEach((port: any) => {
                                        if (port.hostPort) {
                                            ports.push({ host: String(port.hostPort), container: String(port.containerPort) });
                                        } else {
                                            ports.push({ container: String(port.containerPort) });
                                        }
                                    });
                                }
                            });
                        }

                        // Extract Volumes
                        if (parsed.spec.volumes && parsed.spec.containers) {
                            const volumeMap = new Map<string, string>(); // name -> hostPath
                            
                            parsed.spec.volumes.forEach((vol: any) => {
                                if (vol.hostPath && vol.hostPath.path) {
                                    volumeMap.set(vol.name, vol.hostPath.path);
                                } else if (vol.persistentVolumeClaim) {
                                    volumeMap.set(vol.name, `PVC:${vol.persistentVolumeClaim.claimName}`);
                                }
                            });

                            parsed.spec.containers.forEach((container: any) => {
                                if (container.volumeMounts) {
                                    container.volumeMounts.forEach((mount: any) => {
                                        const source = volumeMap.get(mount.name);
                                        if (source) {
                                            volumes.push({ host: source, container: mount.mountPath });
                                        }
                                    });
                                }
                            });
                        }
                    }
                }
            });
        } catch (e) {
            console.error(`Error parsing YAML for ${name}`, e);
        }
    }

    services.push({
      name,
      kubeFile,
      kubePath,
      yamlFile,
      yamlPath,
      active,
      status,
      description,
      ports,
      volumes,
      labels,
      hostNetwork
    });
  }

  return services;
}

export async function getServiceFiles(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const kubePath = `${SYSTEMD_DIR}/${name}.kube`;
  let kubeContent = '';
  let yamlContent = '';
  let yamlPath = '';
  let serviceContent = '';
  let servicePath = '';

  try {
    kubeContent = await executor.readFile(kubePath);
    const yamlMatch = kubeContent.match(/Yaml=(.+)/);
    if (yamlMatch) {
      const yamlFileName = yamlMatch[1].trim();
      if (yamlFileName.startsWith('/')) {
        yamlPath = yamlFileName;
      } else {
        yamlPath = `${SYSTEMD_DIR}/${yamlFileName}`;
      }
      
      try {
        yamlContent = await executor.readFile(yamlPath);
      } catch (e) {
        console.error(`Could not read yaml file ${yamlPath}`, e);
      }
    }

    // Try to fetch the generated service content
    try {
        const { stdout } = await executor.exec(`systemctl --user cat ${name}.service`);
        serviceContent = stdout;

        const { stdout: pathOut } = await executor.exec(`systemctl --user show -p FragmentPath ${name}.service`);
        const match = pathOut.match(/FragmentPath=(.+)/);
        if (match) {
            servicePath = match[1].trim();
        }
    } catch (e) {
        serviceContent = '# Service unit not found or not generated yet.';
    }

  } catch (e) {
    throw new Error(`Service ${name} not found`);
  }

  return { kubeContent, yamlContent, yamlPath, serviceContent, kubePath, servicePath };
}

import { saveSnapshot } from './history';

export async function updateServiceDescription(name: string, description: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const kubePath = `${SYSTEMD_DIR}/${name}.kube`;
  
  try {
    let content = await executor.readFile(kubePath);
    const lines = content.split('\n');
    let unitIndex = -1;
    let descIndex = -1;

    // Simple INI parser/updater
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '[Unit]') {
            unitIndex = i;
        } else if (unitIndex !== -1 && line.startsWith('[') && line.endsWith(']')) {
            break; // End of Unit section
        } else if (unitIndex !== -1 && line.startsWith('Description=')) {
            descIndex = i;
        }
    }

    if (unitIndex === -1) {
        // Add [Unit] section at the top
        content = `[Unit]\nDescription=${description}\n\n${content}`;
    } else if (descIndex !== -1) {
        // Update existing Description
        lines[descIndex] = `Description=${description}`;
        content = lines.join('\n');
    } else {
        // Add Description to existing [Unit] section
        lines.splice(unitIndex + 1, 0, `Description=${description}`);
        content = lines.join('\n');
    }

    await executor.writeFile(kubePath, content);
    await executor.exec('systemctl --user daemon-reload');
  } catch (e) {
    throw new Error(`Failed to update description for ${name}: ${e}`);
  }
}

export async function saveService(name: string, kubeContent: string, yamlContent: string, yamlFileName: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const kubePath = `${SYSTEMD_DIR}/${name}.kube`;
  const yamlPath = `${SYSTEMD_DIR}/${yamlFileName}`;

  // Save snapshots of existing files if they exist
  // Only for local connection for now
  if (!connection) {
    try {
        const existingKube = await executor.readFile(kubePath);
        await saveSnapshot(path.basename(kubePath), existingKube);
    } catch (e) { /* ignore if new file */ }

    try {
        const existingYaml = await executor.readFile(yamlPath);
        await saveSnapshot(path.basename(yamlPath), existingYaml);
    } catch (e) { /* ignore if new file */ }
  }

  await executor.writeFile(kubePath, kubeContent);
  await executor.writeFile(yamlPath, yamlContent);

  // Reload systemd
  await executor.exec('systemctl --user daemon-reload');
}

export async function deleteService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const { yamlPath } = await getServiceFiles(name, connection);
  const kubePath = `${SYSTEMD_DIR}/${name}.kube`;

  try {
    await executor.exec(`systemctl --user stop ${name}.service`);
  } catch (e) {
    // Ignore if already stopped or not loaded
  }

  await executor.rm(kubePath);
  if (yamlPath && (await executor.exists(yamlPath))) {
    await executor.rm(yamlPath);
  }

  await executor.exec('systemctl --user daemon-reload');
}

export async function getServiceLogs(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    const { stdout } = await executor.exec(`journalctl --user -u ${name}.service -n 100 --no-pager`);
    return stdout;
  } catch (e) {
    console.error('Error fetching service logs:', e);
    return '';
  }
}

export async function getPodmanLogs(connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    // Fetch general podman logs from journal
    const { stdout } = await executor.exec(`journalctl --user -t podman -n 100 --no-pager`);
    return stdout;
  } catch (e) {
    console.error('Error fetching podman logs:', e);
    return '';
  }
}

export async function getPodmanPs(connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    // If connection is provided, we use podman -c <connection>
    // BUT, our executor is already wrapping SSH.
    // If we use SSHExecutor, we are running `ssh user@host 'podman ps ...'`
    // This is equivalent to `podman -c connection ps ...` but more generic.
    // However, `podman -c` uses the podman socket, while `ssh podman` uses the CLI on the remote host.
    // Using the CLI on the remote host is safer because it doesn't require the socket to be exposed or forwarded.
    
    const { stdout } = await executor.exec(`podman ps -a --pod --format json`);
    const containers = JSON.parse(stdout);
    // Filter out system containers
     
    return containers.filter((c: any) => {
        const isInfra = c.Names && c.Names.some((n: string) => n.includes('-infra'));
        const isPause = c.Image && c.Image.includes('podman-pause');
        return !isInfra && !isPause;
    });
  } catch (e) {
    console.error('Error fetching podman ps:', e);
    return [];
  }
}

export async function getContainerLogs(containerId: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    const { stdout, stderr } = await executor.exec(`podman logs --tail 100 ${containerId}`);
    return stdout + (stderr ? '\n' + stderr : '');
  } catch (e: any) {
    return (e.stdout || '') + (e.stderr ? '\n' + e.stderr : '');
  }
}

export async function getServiceStatus(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    const { stdout } = await executor.exec(`systemctl --user status ${name}.service`);
    return stdout;
  } catch (e: any) {
    // systemctl status returns non-zero exit code if service is not running, but we still want the output
    return e.stdout || e.message;
  }
}

export async function getAllSystemServices(connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    // List both user and system services? 
    // Usually 'systemctl list-units' lists system services. 
    // 'systemctl --user list-units' lists user services.
    // Let's provide system services as requested.
    // Actually, let's stick to text parsing for broader compatibility
    const { stdout: textOut } = await executor.exec('systemctl list-units --type=service --all --no-pager --plain --no-legend');
    
    return textOut.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          unit: parts[0],
          load: parts[1],
          active: parts[2],
          sub: parts[3],
          description: parts.slice(4).join(' ')
        };
      });
  } catch (e) {
    console.error('Failed to list system services', e);
    return [];
  }
}

export async function updateAndRestartService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const { yamlPath } = await getServiceFiles(name, connection);
  const logs: string[] = [];

  if (yamlPath) {
    try {
      const content = await executor.readFile(yamlPath);
      const parsed = yaml.load(content) as any;
      
      // Find images in Pod spec
      const images = new Set<string>();
      
      const findImages = (obj: any) => {
        if (!obj) return;
        if (obj.image && typeof obj.image === 'string') images.add(obj.image);
        if (Array.isArray(obj.containers)) obj.containers.forEach((c: any) => findImages(c));
        if (Array.isArray(obj.initContainers)) obj.initContainers.forEach((c: any) => findImages(c));
        if (obj.spec) findImages(obj.spec);
        if (obj.template) findImages(obj.template);
      };

      findImages(parsed);

      for (const image of images) {
        logs.push(`Pulling image: ${image}`);
        try {
            await executor.exec(`podman pull ${image}`);
            logs.push(`Successfully pulled ${image}`);
        } catch (e: any) {
            logs.push(`Failed to pull ${image}: ${e.message}`);
        }
      }

    } catch (e) {
      console.error('Error parsing YAML for images', e);
      logs.push('Error parsing YAML to find images.');
    }
  } else {
    logs.push('No YAML file found for this service.');
  }

  logs.push('Reloading systemd daemon...');
  await executor.exec('systemctl --user daemon-reload');

  logs.push(`Stopping service ${name}...`);
  try {
    await executor.exec(`systemctl --user stop ${name}.service`);
  } catch (e) {}

  logs.push(`Starting service ${name}...`);
  try {
    await executor.exec(`systemctl --user start ${name}.service`);
  } catch (e: any) {
     logs.push(`Error starting service: ${e.message}`);
  }

  const status = await getServiceStatus(name, connection);
  return { logs, status };
}

export async function startService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`systemctl --user start ${name}.service`);
  return getServiceStatus(name, connection);
}

export async function stopService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`systemctl --user stop ${name}.service`);
  return getServiceStatus(name, connection);
}

export async function restartService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`systemctl --user restart ${name}.service`);
  return getServiceStatus(name, connection);
}

export async function renameService(oldName: string, newName: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const oldKubePath = `${SYSTEMD_DIR}/${oldName}.kube`;
  const newKubePath = `${SYSTEMD_DIR}/${newName}.kube`;
  
  // Check if new service already exists
  try {
    if (await executor.exists(newKubePath)) {
        throw new Error(`Service ${newName} already exists`);
    }
  } catch (e: any) {
    // Ignore
  }

  // Get old file info
  const content = await executor.readFile(oldKubePath);
  const yamlMatch = content.match(/Yaml=(.+)/);
  const oldYamlFile = yamlMatch ? yamlMatch[1].trim() : null;
  
  if (!oldYamlFile) {
      throw new Error('Could not determine YAML file from .kube file');
  }

  let oldYamlPath = '';
  if (oldYamlFile.startsWith('/')) {
      oldYamlPath = oldYamlFile;
  } else {
      oldYamlPath = `${SYSTEMD_DIR}/${oldYamlFile}`;
  }
  
  // Determine new YAML path (we rename it to match the new service name)
  const newYamlFile = `${newName}.yml`;
  const newYamlPath = `${SYSTEMD_DIR}/${newYamlFile}`;

  // 1. Stop and Disable old service
  try {
      await executor.exec(`systemctl --user disable --now ${oldName}.service`);
  } catch (e) {
      console.warn('Failed to stop old service', e);
  }

  // 2. Rename YAML file
  try {
      await executor.rename(oldYamlPath, newYamlPath);
  } catch (e) {
      throw new Error(`Failed to rename YAML file: ${e}`);
  }

  // 3. Update and Rename Kube file
  const newKubeContent = content.replace(/Yaml=.+/, `Yaml=${newYamlFile}`);
  
  // Also update AutoUpdate if present to ensure it's clean
  // (Optional, but good practice to ensure consistency)

  await executor.writeFile(newKubePath, newKubeContent);
  await executor.rm(oldKubePath);

  // 4. Reload Daemon and Start new service
  await executor.exec('systemctl --user daemon-reload');
  try {
      await executor.exec(`systemctl --user enable --now ${newName}.service`);
  } catch (e) {
      throw new Error(`Failed to start new service: ${e}`);
  }
}

export async function stopContainer(id: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`podman stop ${id}`);
}

export async function forceStopContainer(id: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`podman stop -t 0 ${id}`);
}

export async function restartContainer(id: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`podman restart ${id}`);
}

export async function forceRestartContainer(id: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`podman restart -t 0 ${id}`);
}

export async function deleteContainer(id: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`podman rm -f ${id}`);
}

export async function getContainerInspect(id: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    const { stdout } = await executor.exec(`podman inspect ${id}`);
    const data = JSON.parse(stdout);
    return data[0];
  } catch (e) {
    console.error(`Error inspecting container ${id}:`, e);
    return null;
  }
}

export async function getAllContainersInspect(connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    // Get all container IDs first
    const { stdout: ids } = await executor.exec('podman ps -a -q');
    if (!ids.trim()) return [];
    
    const { stdout } = await executor.exec(`podman inspect ${ids.split('\n').join(' ')}`);
    return JSON.parse(stdout);
  } catch (e) {
    console.error('Error inspecting all containers:', e);
    return [];
  }
}
