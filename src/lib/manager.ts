/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import yaml from 'js-yaml';

const execAsync = promisify(exec);

const SYSTEMD_DIR = path.join(os.homedir(), '.config/containers/systemd');

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
}

export async function listServices(): Promise<ServiceInfo[]> {
  try {
    await fs.access(SYSTEMD_DIR);
  } catch {
    await fs.mkdir(SYSTEMD_DIR, { recursive: true });
  }

  const files = await fs.readdir(SYSTEMD_DIR);
  const kubeFiles = files.filter(f => f.endsWith('.kube'));

  const services: ServiceInfo[] = [];

  for (const kubeFile of kubeFiles) {
    const name = kubeFile.replace('.kube', '');
    const content = await fs.readFile(path.join(SYSTEMD_DIR, kubeFile), 'utf-8');
    
    // Extract Yaml file name from [Kube] section
    const yamlMatch = content.match(/Yaml=(.+)/);
    const yamlFile = yamlMatch ? yamlMatch[1].trim() : null;
    
    const kubePath = path.join(SYSTEMD_DIR, kubeFile);
    let yamlPath = null;
    if (yamlFile) {
        if (path.isAbsolute(yamlFile)) {
            yamlPath = yamlFile;
        } else {
            yamlPath = path.join(SYSTEMD_DIR, yamlFile);
        }
    }

    let active = false;
    let status = 'unknown';
    let description = '';
    const ports: { host?: string; container: string }[] = [];
    const volumes: { host: string; container: string }[] = [];

    try {
      const { stdout } = await execAsync(`systemctl --user is-active ${name}.service`);
      status = stdout.trim();
      active = status === 'active';
      
      // Get Description
      const { stdout: descStdout } = await execAsync(`systemctl --user show -p Description --value ${name}.service`);
      description = descStdout.trim();
    } catch (e) {
      status = 'inactive'; // or error
    }

    if (yamlPath) {
        try {
            const yamlContent = await fs.readFile(yamlPath, 'utf-8');
            const parsed = yaml.load(yamlContent) as any;
            
            if (parsed && parsed.spec) {
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
      volumes
    });
  }

  return services;
}

export async function getServiceFiles(name: string) {
  const kubePath = path.join(SYSTEMD_DIR, `${name}.kube`);
  let kubeContent = '';
  let yamlContent = '';
  let yamlPath = '';
  let serviceContent = '';
  let servicePath = '';

  try {
    kubeContent = await fs.readFile(kubePath, 'utf-8');
    const yamlMatch = kubeContent.match(/Yaml=(.+)/);
    if (yamlMatch) {
      const yamlFileName = yamlMatch[1].trim();
      if (path.isAbsolute(yamlFileName)) {
        yamlPath = yamlFileName;
      } else {
        yamlPath = path.join(SYSTEMD_DIR, yamlFileName);
      }
      
      try {
        yamlContent = await fs.readFile(yamlPath, 'utf-8');
      } catch (e) {
        console.error(`Could not read yaml file ${yamlPath}`, e);
      }
    }

    // Try to fetch the generated service content
    try {
        const { stdout } = await execAsync(`systemctl --user cat ${name}.service`);
        serviceContent = stdout;

        const { stdout: pathOut } = await execAsync(`systemctl --user show -p FragmentPath ${name}.service`);
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

export async function saveService(name: string, kubeContent: string, yamlContent: string, yamlFileName: string) {
  const kubePath = path.join(SYSTEMD_DIR, `${name}.kube`);
  const yamlPath = path.join(SYSTEMD_DIR, yamlFileName);

  // Save snapshots of existing files if they exist
  try {
    const existingKube = await fs.readFile(kubePath, 'utf-8');
    await saveSnapshot(path.basename(kubePath), existingKube);
  } catch (e) { /* ignore if new file */ }

  try {
    const existingYaml = await fs.readFile(yamlPath, 'utf-8');
    await saveSnapshot(path.basename(yamlPath), existingYaml);
  } catch (e) { /* ignore if new file */ }

  await fs.writeFile(kubePath, kubeContent);
  await fs.writeFile(yamlPath, yamlContent);

  // Reload systemd
  await execAsync('systemctl --user daemon-reload');
}

export async function deleteService(name: string) {
  const { yamlPath } = await getServiceFiles(name);
  const kubePath = path.join(SYSTEMD_DIR, `${name}.kube`);

  try {
    await execAsync(`systemctl --user stop ${name}.service`);
  } catch (e) {
    // Ignore if already stopped or not loaded
  }

  await fs.unlink(kubePath);
  if (yamlPath && (await fs.stat(yamlPath).catch(() => false))) {
    await fs.unlink(yamlPath);
  }

  await execAsync('systemctl --user daemon-reload');
}

export async function getServiceLogs(name: string) {
  try {
    const { stdout } = await execAsync(`journalctl --user -u ${name}.service -n 100 --no-pager`);
    return stdout;
  } catch (e) {
    console.error('Error fetching service logs:', e);
    return '';
  }
}

export async function getPodmanLogs() {
  try {
    // Fetch general podman logs from journal
    const { stdout } = await execAsync(`journalctl --user -t podman -n 100 --no-pager`);
    return stdout;
  } catch (e) {
    console.error('Error fetching podman logs:', e);
    return '';
  }
}

export async function getPodmanPs() {
  try {
    const { stdout } = await execAsync(`podman ps -a --format json`);
    return JSON.parse(stdout);
  } catch (e) {
    console.error('Error fetching podman ps:', e);
    return [];
  }
}

export async function getContainerLogs(containerId: string) {
  try {
    const { stdout, stderr } = await execAsync(`podman logs --tail 100 ${containerId}`);
    return stdout + (stderr ? '\n' + stderr : '');
  } catch (e: any) {
    return (e.stdout || '') + (e.stderr ? '\n' + e.stderr : '');
  }
}

export async function getServiceStatus(name: string) {
  try {
    const { stdout } = await execAsync(`systemctl --user status ${name}.service`);
    return stdout;
  } catch (e: any) {
    // systemctl status returns non-zero exit code if service is not running, but we still want the output
    return e.stdout || e.message;
  }
}

export async function getAllSystemServices() {
  try {
    // List both user and system services? 
    // Usually 'systemctl list-units' lists system services. 
    // 'systemctl --user list-units' lists user services.
    // Let's provide system services as requested.
    const { stdout } = await execAsync('systemctl list-units --type=service --all --no-pager --plain --no-legend --output=json');
    // Note: --output=json is available in newer systemd versions. 
    // If not available, we might need to parse text.
    // Let's try text parsing for compatibility if json fails or just use text parsing to be safe.
    
    // Actually, let's stick to text parsing for broader compatibility
    const { stdout: textOut } = await execAsync('systemctl list-units --type=service --all --no-pager --plain --no-legend');
    
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

export async function updateAndRestartService(name: string) {
  const { yamlPath } = await getServiceFiles(name);
  const logs: string[] = [];

  if (yamlPath) {
    try {
      const content = await fs.readFile(yamlPath, 'utf-8');
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
            await execAsync(`podman pull ${image}`);
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
  await execAsync('systemctl --user daemon-reload');

  logs.push(`Stopping service ${name}...`);
  try {
    await execAsync(`systemctl --user stop ${name}.service`);
  } catch (e) {}

  logs.push(`Starting service ${name}...`);
  try {
    await execAsync(`systemctl --user start ${name}.service`);
  } catch (e: any) {
     logs.push(`Error starting service: ${e.message}`);
  }

  const status = await getServiceStatus(name);
  return { logs, status };
}

export async function startService(name: string) {
  await execAsync(`systemctl --user start ${name}.service`);
  return getServiceStatus(name);
}

export async function stopService(name: string) {
  await execAsync(`systemctl --user stop ${name}.service`);
  return getServiceStatus(name);
}

export async function restartService(name: string) {
  await execAsync(`systemctl --user restart ${name}.service`);
  return getServiceStatus(name);
}

export async function renameService(oldName: string, newName: string) {
  const oldKubePath = path.join(SYSTEMD_DIR, `${oldName}.kube`);
  const newKubePath = path.join(SYSTEMD_DIR, `${newName}.kube`);
  
  // Check if new service already exists
  try {
    await fs.access(newKubePath);
    throw new Error(`Service ${newName} already exists`);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Get old file info
  const content = await fs.readFile(oldKubePath, 'utf-8');
  const yamlMatch = content.match(/Yaml=(.+)/);
  const oldYamlFile = yamlMatch ? yamlMatch[1].trim() : null;
  
  if (!oldYamlFile) {
      throw new Error('Could not determine YAML file from .kube file');
  }

  const oldYamlPath = path.isAbsolute(oldYamlFile) 
      ? oldYamlFile 
      : path.join(SYSTEMD_DIR, oldYamlFile);
  
  // Determine new YAML path (we rename it to match the new service name)
  const newYamlFile = `${newName}.yml`;
  const newYamlPath = path.join(SYSTEMD_DIR, newYamlFile);

  // 1. Stop and Disable old service
  try {
      await execAsync(`systemctl --user disable --now ${oldName}.service`);
  } catch (e) {
      console.warn('Failed to stop old service', e);
  }

  // 2. Rename YAML file
  try {
      await fs.rename(oldYamlPath, newYamlPath);
  } catch (e) {
      throw new Error(`Failed to rename YAML file: ${e}`);
  }

  // 3. Update and Rename Kube file
  const newKubeContent = content.replace(/Yaml=.+/, `Yaml=${newYamlFile}`);
  
  // Also update AutoUpdate if present to ensure it's clean
  // (Optional, but good practice to ensure consistency)

  await fs.writeFile(newKubePath, newKubeContent);
  await fs.unlink(oldKubePath);

  // 4. Reload Daemon and Start new service
  await execAsync('systemctl --user daemon-reload');
  try {
      await execAsync(`systemctl --user enable --now ${newName}.service`);
  } catch (e) {
      throw new Error(`Failed to start new service: ${e}`);
  }
}

export async function stopContainer(id: string) {
  await execAsync(`podman stop ${id}`);
}

export async function forceStopContainer(id: string) {
  await execAsync(`podman stop -t 0 ${id}`);
}

export async function restartContainer(id: string) {
  await execAsync(`podman restart ${id}`);
}

export async function forceRestartContainer(id: string) {
  await execAsync(`podman restart -t 0 ${id}`);
}

export async function deleteContainer(id: string) {
  await execAsync(`podman rm -f ${id}`);
}
