/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { getExecutor } from './executor';
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
  activeState?: string;
  subState?: string;
  description?: string;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  labels: Record<string, string>;
  hostNetwork?: boolean;
  node?: string; // Added node name
  id?: string; // Optional ID for mapping display name to service name
  isReverseProxy?: boolean; // Flag to identify the reverse proxy service
  isServiceBay?: boolean; // Flag to identify the ServiceBay self-service
}

/**
 * @deprecated Use ServiceManager.listServices instead. This implementation relies on legacy executor patterns.
 */
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
      // Determine if this is an Agent connection issue
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Agent not connected')) {
          throw new Error(`Failed to communicate with ServiceBay Agent on ${connection?.Name || 'Remote Node'}.\nCheck if the node is online and the agent is running.`);
      }
      throw e;
  }

  const systemdDir = getSystemdDir(connection);
  // Optimized batch fetch script to reduce SSH round-trips
  const script = `
    cd "${systemdDir}" || exit 0
    
    echo "DEBUG_INFO: $(id) | $(env | grep -E 'XDG|DBUS')"
    
    # Pre-flight check for systemd accessibility
    if ! systemctl --user list-units --no-pager -n 0 >/dev/null 2>&1; then
        echo "ERROR_SYSTEMD_ACCESS_FAILED"
        exit 1
    fi

    # Loop over .kube files only (Strict Kube-First Architecture)
    for f in *.kube; do
        [ -e "$f" ] || continue
        
        # Determine Name and Type (Only kube supported now)
        case "$f" in
            *.kube)
                name="\${f%.kube}"
                type="kube"
                ;;
            *)
                # Should not happen given the loop, but fallback
                continue
                ;;
        esac

        echo "---SERVICE_START---"
        echo "NAME: $name"
        echo "TYPE: $type"
        echo "FILE: $f"
        
        # Robust status check - capture stderr for debugging
        svc_status=$(systemctl --user is-active "$name.service" 2>&1)
        exit_code=$?
        
        if [ $exit_code -ne 0 ]; then
             # If completely empty, assume inactive (race condition or weird state)
             if [ -z "$svc_status" ]; then
                # Include debug info in the inactive status so we can verify user identity
                svc_status="inactive (uid: $(id -u))"
             else
                # If it has content (e.g. error message), keep it so we see it in the UI/Logs
                # But systemctl returns 'inactive' (exit 3) or 'failed' (exit 3) or 'unknown (exit 4)
                # 'failed' state is valid content.
                # Error messages (like 'Bus error') are also content.
                # Let's prefix error for clarity if it looks like an error
                if [[ "$svc_status" == *"Failed to"* ]] || [[ "$svc_status" == *"No such"* ]]; then
                     svc_status="ERROR: $svc_status"
                fi
             fi
        fi
        echo "STATUS: $svc_status"
        
        # Get detailed states
        echo "STATE_DETAILS_START"
        systemctl --user show -p ActiveState,SubState "$name.service"
        echo "STATE_DETAILS_END"

        echo "DESCRIPTION: $(systemctl --user show -p Description --value "$name.service" 2>/dev/null)"
        echo "CONTENT_START"
        cat "$f"
        echo "CONTENT_END"
        
        # Only parse Yaml for Kube types
        if [ "$type" = "kube" ]; then
            yaml_file=$(grep "^Yaml=" "$f" | head -n1 | cut -d= -f2- | sed 's/^[ \t]*//;s/[ \t]*$//')
            if [ -n "$yaml_file" ]; then
                echo "YAML_CONTENT_START"
                case "$yaml_file" in
                    /*) cat "$yaml_file" 2>/dev/null ;;
                    *) cat "$yaml_file" 2>/dev/null ;;
                esac
                echo "YAML_CONTENT_END"
            fi
        fi
        echo "---SERVICE_END---"
    done
  `;

  let stdout = '';
  try {
      const res = await executor.exec(script);
      stdout = res.stdout;
      // Debug logging to troubleshoot status issues
      if (stdout.includes('STATUS: inactive') || stdout.includes('STATUS: failed')) {
          console.log('[ServiceManager] Raw Batch Output:', stdout);
      }
  } catch (e) {
      console.error('Failed to fetch services batch', e);
      const err = e as { stdout?: string };
      if (err.stdout && err.stdout.includes('ERROR_SYSTEMD_ACCESS_FAILED')) {
          throw new Error('Systemd User Session inaccessible. Check DBUS/XDG environment.');
      }
      // Propagate error to let the UI handle it properly
      throw e;
  }

  const services: ServiceInfo[] = [];
  const serviceBlocks = stdout.split('---SERVICE_START---').filter(b => b.trim());

  for (const block of serviceBlocks) {
      const lines = block.split('\n');
      const nameLine = lines.find(l => l.startsWith('NAME: '));
      const fileLine = lines.find(l => l.startsWith('FILE: '));
      const statusLine = lines.find(l => l.startsWith('STATUS: '));
      const descLine = lines.find(l => l.startsWith('DESCRIPTION: '));
      
      if (!nameLine) continue;
      
      let name = nameLine.substring(6).trim();
       
      // Fix: Strip extensions that might have leaked from the shell script or weird filenames
      // This fixes the 'foo.kube' name issue reported by users
      name = name.replace(/\.(kube|container|service|pod)$/, '');

      const fileName = fileLine ? fileLine.substring(6).trim() : `${name}.kube`;
      const status = statusLine ? statusLine.substring(8).trim() : 'unknown';
      let description = descLine ? descLine.substring(13).trim() : '';
      
      // Extract detailed states
      const stateStart = block.indexOf('STATE_DETAILS_START');
      const stateEnd = block.indexOf('STATE_DETAILS_END');
      let activeState = '';
      let subState = '';
      
      if (stateStart !== -1 && stateEnd !== -1) {
          const stateBlock = block.substring(stateStart + 19, stateEnd).trim();
          const matchActive = stateBlock.match(/ActiveState=(.+)/);
          const matchSub = stateBlock.match(/SubState=(.+)/);
          if (matchActive) activeState = matchActive[1].trim();
          if (matchSub) subState = matchSub[1].trim();
      }

      // Enhanced Active Check: Consider ActiveState property as authority if available
      // 'is-active' command (captured in status) is usually reliable but sometimes exit codes vary
      const isActiveState = activeState === 'active' || activeState === 'reloading';
      const active = isActiveState || status === 'active';

      // Extract Content (Kube or Container)
      const contentStart = block.indexOf('CONTENT_START');
      const contentEnd = block.indexOf('CONTENT_END');
      let content = '';
      if (contentStart !== -1 && contentEnd !== -1) {
          content = block.substring(contentStart + 13, contentEnd).trim();
      }

      // Extract Yaml Content (Kube only)
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
      // Map 'kubePath' to the actual source file (legacy naming)
      const kubePath = path.join(systemdDir, fileName);
      
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
      } else if (content) {
          // Fallback: Parse attributes from Quadlet .container files
          // Parse PublishPort (e.g., PublishPort=8080:80)
          const portMatches = content.matchAll(/PublishPort=(.+)/g);
          for (const match of portMatches) {
              const val = match[1].trim();
              // Handle ip:hostPort:containerPort vs hostPort:containerPort vs containerPort
              const parts = val.split(':');
              if (parts.length === 3) {
                   // ip:host:container
                   ports.push({ host: parts[1], container: parts[2] });
              } else if (parts.length === 2) {
                   // host:container
                   ports.push({ host: parts[0], container: parts[1] });
              } else {
                   // container
                   ports.push({ container: val });
              }
          }

          // Parse Labels (e.g., Label=foo=bar)
          const labelMatches = content.matchAll(/Label=(.+)/g);
          for (const match of labelMatches) {
               const val = match[1].trim();
               const firstEq = val.indexOf('=');
               if (firstEq !== -1) {
                   const k = val.substring(0, firstEq);
                   const v = val.substring(firstEq + 1);
                   labels[k] = v;
               }
          }
          
          // Parse Host Network
          if (content.match(/Network=host/)) {
              hostNetwork = true;
          }
      }

      // Deduplicate services by name to prevent multiple files (e.g. .kube and .container)
      // from showing as separate services if they map to the same systemd unit.
      const existing = services.find(s => s.name === name);
      if (existing) {
          // If we found a duplicate, we might want to update it if the new one 
          // provides more info (like yaml content), but for now we skip to avoid key collisions.
          continue;
      }

      services.push({
        id: name, // Unique ID for React keys
        name: name, // Display Name
        kubeFile: fileName,
        kubePath,
        yamlFile,
        yamlPath,
        active,
        status,
        activeState,
        subState,
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
    } catch {
        serviceContent = '# Service unit not found or not generated yet.';
    }

  } catch (e) {
    console.error(`Error reading service files for ${name}:`, e);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Service ${name} not found: ${msg}`);
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
    } catch { /* ignore if new file */ }

    try {
        const existingYaml = await executor.readFile(yamlPath);
        await saveSnapshot(path.basename(yamlPath), existingYaml);
    } catch { /* ignore if new file */ }
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
  } catch {
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
    // Determine unit name: Append .service if missing, unless it's a quadlet type
    // But journalctl usually requires .service for exact match or works with alias.
    // Safest is to append .service if it doesn't have an extension.
    let unit = name;
    if (!unit.match(/\.(service|scope|socket|timer)$/)) {
        unit += '.service';
    }

    const { stdout } = await executor.exec(`journalctl --user -u ${unit} -n 100 --no-pager`);
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

// New helper to get enriched container data (unified source of truth)
export async function getEnrichedContainers(connection?: PodmanConnection) {
    const [containers, inspects] = await Promise.all([
        getPodmanPs(connection),
        getAllContainersInspect(connection)
    ]);

    // Create a map of inspect data for quick lookup
     
    const inspectMap = new Map<string, any>();
     
    inspects.forEach((i: any) => inspectMap.set(i.Id, i));

    // Identify Host Network Containers to fetch real ports
    const hostPids: number[] = [];
     
    const pidToContainer = new Map<number, any>();

    // Enrich containers
     
    const enriched = containers.map((c: any) => {
        const inspect = inspectMap.get(c.Id);
        let networkMode = 'unknown';
        
        // Robust Host Network Detection
        if (inspect) {
            if (inspect.HostConfig?.NetworkMode === 'host') {
                networkMode = 'host';
            } else if (inspect.NetworkSettings?.Networks?.['host']) {
                networkMode = 'host';
            } else if (inspect.HostConfig?.NetworkMode) {
                networkMode = inspect.HostConfig.NetworkMode;
            } else if (inspect.NetworkSettings?.Networks) {
                networkMode = Object.keys(inspect.NetworkSettings.Networks).join(', ');
            }
        }
        
        const isHost = networkMode === 'host';

        // Collect PID if host network and running
        if (isHost && c.State === 'running' && inspect?.State?.Pid) {
            hostPids.push(inspect.State.Pid);
            pidToContainer.set(inspect.State.Pid, c);
        }

        return {
            ...c,
            NetworkMode: networkMode,
            IsHostNetwork: isHost,
            // Attach full inspect data if needed, or at least keep it accessible?
            // For now, let's just stick to PS format enriched with metadata
        };
    });

    // Fetch real ports for host network containers
    if (hostPids.length > 0) {
        const hostPorts = await getHostPortsForPids(hostPids, connection);
        
        // Update enriched containers
         
        enriched.forEach((c: any) => {
            if (c.IsHostNetwork && c.State === 'running') {
                const inspect = inspectMap.get(c.Id);
                if (inspect?.State?.Pid) {
                    const ports = hostPorts.get(inspect.State.Pid);
                    if (ports && ports.length > 0) {
                        console.log(`[Manager] Uses dynamic host ports for ${c.Names?.[0] || c.Id}: ${ports.map((p: any) => p.hostPort).join(', ')}`);
                        
                        // 1. Update Ports (Podman PS format)
                        c.Ports = ports;

                        // 2. Update ExposedPorts (Inspect format)
                        const exposed: Record<string, object> = {};
                         
                        ports.forEach((p: any) => {
                            const protocol = p.protocol || 'tcp';
                            exposed[`${p.hostPort}/${protocol}`] = {};
                        });
                        c.ExposedPorts = exposed;
                        
                        // 3. Update NetworkSettings.Ports (for deep compatibility)
                        if (!c.NetworkSettings) c.NetworkSettings = {};
                        if (!c.NetworkSettings.Ports) c.NetworkSettings.Ports = {};
                         
                        ports.forEach((p: any) => {
                            const key = `${p.hostPort}/${p.protocol || 'tcp'}`;
                            if (!c.NetworkSettings.Ports[key]) {
                                c.NetworkSettings.Ports[key] = [{
                                    HostIp: p.hostIp,
                                    HostPort: String(p.hostPort)
                                }];
                            }
                        });
                    }
                }
            }
        });
    }

    return [enriched, inspects];
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

export async function getServiceStatus(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const serviceName = name.endsWith('.service') ? name : `${name}.service`;
  try {
    const { stdout } = await executor.exec(`systemctl --user status ${serviceName}`);
    return stdout;
  } catch (e) {
    // systemctl status returns non-zero exit code if service is not running, but we still want the output
    const err = e as { stdout?: string; message: string };
    return err.stdout || err.message;
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
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logs.push(`Failed to pull ${image}: ${msg}`);
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
  
  const serviceName = name.endsWith('.service') ? name : `${name}.service`;

  logs.push(`Stopping service ${serviceName}...`);
  try {
    await executor.exec(`systemctl --user stop ${serviceName}`);
  } catch {}

  logs.push(`Starting service ${serviceName}...`);
  try {
    await executor.exec(`systemctl --user start ${serviceName}`);
  } catch (e) {
     const msg = e instanceof Error ? e.message : String(e);
     logs.push(`Error starting service: ${msg}`);
  }

  const status = await getServiceStatus(name, connection);
  return { logs, status };
}

/**
 * @deprecated Use ServiceManager.startService instead.
 */
export async function startService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const serviceName = name.endsWith('.service') ? name : `${name}.service`;
  await executor.exec(`systemctl --user start ${serviceName}`);
  return getServiceStatus(name, connection);
}

/**
 * @deprecated Use ServiceManager.stopService instead.
 */
export async function stopService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const serviceName = name.endsWith('.service') ? name : `${name}.service`;
  await executor.exec(`systemctl --user stop ${serviceName}`);
  return getServiceStatus(name, connection);
}

export async function restartService(name: string, connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  const serviceName = name.endsWith('.service') ? name : `${name}.service`;
  await executor.exec(`systemctl --user restart ${serviceName}`);
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
  } catch {
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

async function getHostPortsForPids(pids: number[], connection?: PodmanConnection) {
    if (pids.length === 0) return new Map<number, any[]>();
    const executor = getExecutor(connection);
    
    try {
        // Fetch listening ports and process tree in parallel
        const [ssRes, psRes] = await Promise.all([
            executor.exec('ss -tulpnH'),
            executor.exec('ps -eo pid,ppid --no-headers')
        ]);

        const { stdout } = ssRes;
        const psOut = psRes.stdout;
        
        // Build child -> parent map for process tree traversal
        const parentMap = new Map<number, number>();
        psOut.split('\n').forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const pid = parseInt(parts[0]);
                const ppid = parseInt(parts[1]);
                if (!isNaN(pid) && !isNaN(ppid)) {
                    parentMap.set(pid, ppid);
                }
            }
        });

        // console.log('[HostPorts] Raw SS output length:', stdout.length);
        const map = new Map<number, any[]>();
        const targetPids = new Set(pids);

        // Debug logging for troubleshooting port matching
        console.log(`[HostPorts] Scanning for PIDs (and children): [${pids.join(', ')}]`);
        
        stdout.split('\n').forEach(line => {
             const parts = line.trim().split(/\s+/);
             if (parts.length < 5) return;
             
             // Netid State Recv-Q Send-Q Local_Address:Port Peer_Address:Port Process
             // Example: tcp LISTEN 0 128 *:80 *:* users:(("nginx",pid=123,fd=4))
             const protocol = parts[0];
             const localAddr = parts[4];
             const processField = parts.slice(6).join(' ');

             const pidMatches = processField.matchAll(/pid=(\d+)/g);
             for (const match of pidMatches) {
                 const foundPid = parseInt(match[1]);
                 
                 // Resolve foundPID to a target container PID (if it's the PID itself or a descendant)
                 let assignedPid = -1;
                 
                 if (targetPids.has(foundPid)) {
                     assignedPid = foundPid;
                 } else {
                     // Check ancestry
                     let current = foundPid;
                     let depth = 0;
                     // Walk up max 10 levels to avoid infinite loops
                     while (parentMap.has(current) && depth < 10) {
                         const parent = parentMap.get(current)!;
                         if (targetPids.has(parent)) {
                             assignedPid = parent;
                             break;
                         }
                         // Stop if we hit init/root
                         if (parent <= 1) break;
                         current = parent;
                         depth++;
                     }
                 }

                 if (assignedPid !== -1) {
                     const lastColon = localAddr.lastIndexOf(':');
                     const ipStr = localAddr.substring(0, lastColon).replace('[', '').replace(']', '');
                     const port = parseInt(localAddr.substring(lastColon + 1));
                     
                     // Normalize IP
                     const hostIp = (ipStr === '*' || ipStr === '') ? '0.0.0.0' : ipStr;

                     const portInfo = {
                         hostIp: hostIp,
                         containerPort: port,
                         hostPort: port,
                         protocol: protocol
                     };

                     const existing = map.get(assignedPid) || [];
                     // Avoid exact duplicates
                     const isDuplicate = existing.some(p => 
                        p.hostPort === port && p.protocol === protocol && p.hostIp === hostIp
                     );
                     
                     if (!isDuplicate) {
                        existing.push(portInfo);
                        map.set(assignedPid, existing);
                     }
                 }
             }
        });
        
        // Debug result
        map.forEach((ports, pid) => console.log(`[HostPorts] PID ${pid} found ports: ${ports.length}`));
        
        return map;
    } catch (e) {
        console.warn('Failed to get host ports', e);
        return new Map<number, any[]>();
    }
}

export interface VolumeInfo {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string>;
  Options: Record<string, string>;
  Scope: string;
  Node?: string; // Tag for the node
  UsedBy: { id: string; name: string }[];
  Anonymous?: boolean;
}

export async function listVolumes(connection?: PodmanConnection): Promise<VolumeInfo[]> {
  const executor = getExecutor(connection);
  try {
    const [volumesRes, containers] = await Promise.all([
        executor.exec('podman volume ls --format json'),
        getPodmanPs(connection)
    ]);

    if (!volumesRes.stdout.trim()) return [];
    
    // Parse Volumes
    const volumes: VolumeInfo[] = JSON.parse(volumesRes.stdout);
    
    // Map usage
    const usageMap = new Map<string, { id: string; name: string }[]>();
    
    // Helper to add usage
    const addUsage = (volName: string, containerId: string, containerName: string) => {
        const current = usageMap.get(volName) || [];
        // Avoid duplicates if multiple mounts from same container
        if (!current.some(c => c.id === containerId)) {
            current.push({ id: containerId.substring(0, 12), name: containerName });
        }
        usageMap.set(volName, current);
    };

    containers.forEach((container: any) => {
        const name = container.Names && container.Names.length > 0 ? container.Names[0] : container.Id.substring(0, 12);
        
        if (container.Mounts) {
            container.Mounts.forEach((mount: any) => {
                // Type 'volume' has a Name. 'bind' has Source.
                if (mount.Type === 'volume' && mount.Name) {
                    addUsage(mount.Name, container.Id, name);
                } 
                // Sometimes named volumes might appear differently, but 'Name' is standard for docker/podman volumes
            });
        }
    });

    // Enrich volumes
    volumes.forEach((v) => {
        v.UsedBy = usageMap.get(v.Name) || [];
        
        // Add Node Name to volume info if connection is present
        if (connection) {
            v.Node = connection.Name;
        }

        // Detect anonymous volumes (64 char hex string)
        if (/^[0-9a-f]{64}$/.test(v.Name)) {
            v.Anonymous = true;
        } else {
            v.Anonymous = false;
        }
    });

    return volumes;
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
