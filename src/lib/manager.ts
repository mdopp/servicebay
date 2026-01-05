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
// If running in container, this path is relative to /root (or whatever user).
// But we are not mounting host's systemd dir.
// So "Local" management is effectively disabled/empty unless we mount it.
function getSystemdDir(connection?: PodmanConnection) {
    if (connection) {
        return '.config/containers/systemd';
    }
    return path.join(os.homedir(), '.config/containers/systemd');
}

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
  id?: string; // Optional ID for mapping display name to service name
}

export async function listServices(connection?: PodmanConnection): Promise<ServiceInfo[]> {
  // If no connection is provided, we are in "Local" mode.
  // But "Local" is disabled for services.
  if (!connection) {
      return [];
  }

  const executor = getExecutor(connection);
  
  try {
    const systemdDir = getSystemdDir(connection);
    if (!(await executor.exists(systemdDir))) {
        await executor.mkdir(systemdDir);
    }
  } catch (e) {
      console.error('Failed to access systemd dir', e);
      return [];
  }

  const systemdDir = getSystemdDir(connection);
  // Optimized batch fetch script to reduce SSH round-trips
  const script = `
    cd "${systemdDir}" || exit 0
    for f in *.kube; do
        [ -e "$f" ] || continue
        name="\${f%.kube}"
        echo "---SERVICE_START---"
        echo "NAME: $name"
        echo "STATUS: $(systemctl --user is-active "$name.service" 2>/dev/null || echo inactive)"
        echo "DESCRIPTION: $(systemctl --user show -p Description --value "$name.service" 2>/dev/null)"
        echo "KUBE_CONTENT_START"
        cat "$f"
        echo "KUBE_CONTENT_END"
        
        yaml_file=$(grep "^Yaml=" "$f" | head -n1 | cut -d= -f2- | sed 's/^[ \t]*//;s/[ \t]*$//')
        if [ -n "$yaml_file" ]; then
            echo "YAML_CONTENT_START"
            if [[ "$yaml_file" == /* ]]; then
                cat "$yaml_file" 2>/dev/null
            else
                cat "$yaml_file" 2>/dev/null
            fi
            echo "YAML_CONTENT_END"
        fi
        echo "---SERVICE_END---"
    done
  `;

  let stdout = '';
  try {
      const res = await executor.exec(script);
      stdout = res.stdout;
  } catch (e) {
      console.error('Failed to fetch services batch', e);
      return [];
  }

  const services: ServiceInfo[] = [];
  const serviceBlocks = stdout.split('---SERVICE_START---').filter(b => b.trim());

  for (const block of serviceBlocks) {
      const lines = block.split('\n');
      const nameLine = lines.find(l => l.startsWith('NAME: '));
      const statusLine = lines.find(l => l.startsWith('STATUS: '));
      const descLine = lines.find(l => l.startsWith('DESCRIPTION: '));
      
      if (!nameLine) continue;
      
      const name = nameLine.substring(6).trim();
      const status = statusLine ? statusLine.substring(8).trim() : 'unknown';
      let description = descLine ? descLine.substring(13).trim() : '';
      const active = status === 'active';

      // Extract Kube Content
      const kubeStart = block.indexOf('KUBE_CONTENT_START');
      const kubeEnd = block.indexOf('KUBE_CONTENT_END');
      let content = '';
      if (kubeStart !== -1 && kubeEnd !== -1) {
          content = block.substring(kubeStart + 19, kubeEnd).trim();
      }

      // Extract Yaml Content
      const yamlStart = block.indexOf('YAML_CONTENT_START');
      const yamlEnd = block.indexOf('YAML_CONTENT_END');
      let yamlContent = '';
      if (yamlStart !== -1 && yamlEnd !== -1) {
          yamlContent = block.substring(yamlStart + 19, yamlEnd).trim();
      }

      // Fallback description from file
      if (!description && content) {
        const match = content.match(/Description=(.+)/);
        if (match) {
            description = match[1].trim();
        }
      }

      const systemdDir = getSystemdDir(connection);
      const kubePath = path.join(systemdDir, `${name}.kube`);
      
      // Extract Yaml file name for reference
      const yamlMatch = content.match(/Yaml=(.+)/);
      const yamlFile = yamlMatch ? yamlMatch[1].trim() : null;
      let yamlPath = null;
      if (yamlFile) {
        if (yamlFile.startsWith('/')) {
            yamlPath = yamlFile;
        } else {
            yamlPath = path.join(systemdDir, yamlFile);
        }
      }

      const ports: { host?: string; container: string }[] = [];
      const volumes: { host: string; container: string }[] = [];
      let labels: Record<string, string> = {};
      let hostNetwork = false;

      if (yamlContent) {
        try {
            const documents = yaml.loadAll(yamlContent) as any[];
            documents.forEach((parsed) => {
                if (parsed) {
                    if (parsed.metadata && parsed.metadata.labels) {
                        labels = { ...labels, ...parsed.metadata.labels };
                    }
                    if (parsed.spec) {
                        if (parsed.spec.hostNetwork) {
                            hostNetwork = true;
                        }
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
                            const volumeMap = new Map<string, string>();
                            
                            parsed.spec.volumes.forEach((vol: any) => {
                                if (vol.hostPath && vol.hostPath.path) {
                                    volumeMap.set(vol.name, vol.hostPath.path);
                                } else if (vol.persistentVolumeClaim) {
                                    volumeMap.set(vol.name, `PVC:\${vol.persistentVolumeClaim.claimName}`);
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
            console.warn(`Failed to parse YAML for ${name}`, e);
        }
      }

      services.push({
        name,
        kubeFile: `${name}.kube`,
        kubePath,
        yamlFile,
        yamlPath,
        active,
        status,
        description,
        ports,
        volumes,
        labels,
        hostNetwork,
        node: connection?.Name || 'Local'
      });
  }

  return services;
}

export async function getServiceFiles(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const systemdDir = getSystemdDir(connection);
  const kubePath = path.join(systemdDir, `${name}.kube`);
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
        yamlPath = path.join(systemdDir, yamlFileName);
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

  } catch (e: any) {
    console.error(`Error reading service files for ${name}:`, e);
    throw new Error(`Service ${name} not found: ${e.message}`);
  }

  return { kubeContent, yamlContent, yamlPath, serviceContent, kubePath, servicePath };
}

import { saveSnapshot } from './history';

export async function updateServiceDescription(name: string, description: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const systemdDir = getSystemdDir(connection);
  const kubePath = path.join(systemdDir, `${name}.kube`);
  
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
  const systemdDir = getSystemdDir(connection);
  const kubePath = path.join(systemdDir, `${name}.kube`);
  const yamlPath = path.join(systemdDir, yamlFileName);

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
  const systemdDir = getSystemdDir(connection);
  const kubePath = path.join(systemdDir, `${name}.kube`);

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
  const systemdDir = getSystemdDir(connection);
  const oldKubePath = path.join(systemdDir, `${oldName}.kube`);
  const newKubePath = path.join(systemdDir, `${newName}.kube`);
  
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
      oldYamlPath = path.join(systemdDir, oldYamlFile);
  }
  
  // Determine new YAML path (we rename it to match the new service name)
  const newYamlFile = `${newName}.yml`;
  const newYamlPath = path.join(systemdDir, newYamlFile);

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
  if (!connection) {
      return [];
  }
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

export interface VolumeInfo {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string>;
  Options: Record<string, string>;
  Scope: string;
}

export async function listVolumes(connection?: PodmanConnection): Promise<VolumeInfo[]> {
  const executor = getExecutor(connection);
  try {
    const { stdout } = await executor.exec('podman volume ls --format json');
    if (!stdout.trim()) return [];
    return JSON.parse(stdout);
  } catch (e) {
    console.error('Error listing volumes:', e);
    return [];
  }
}

export async function createVolume(name: string, options?: Record<string, string>, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  let cmd = `podman volume create ${name}`;
  if (options) {
    for (const [key, value] of Object.entries(options)) {
      cmd += ` --opt ${key}=${value}`;
    }
  }
  await executor.exec(cmd);
}

export async function removeVolume(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  await executor.exec(`podman volume rm ${name}`);
}
