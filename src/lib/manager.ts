/* eslint-disable @typescript-eslint/no-explicit-any */
import { getExecutor } from './executor';
import { PodmanConnection } from './nodes';

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

async function getAllContainersInspect(connection?: PodmanConnection) {
  if (!connection) {
      return [];
  }
  const executor = getExecutor(connection);
  try {
    const { stdout: ids } = await executor.exec('podman ps -a -q');
    if (!ids.trim()) return [];

    const { stdout } = await executor.exec(`podman inspect ${ids.split('\n').join(' ')}`);
    return JSON.parse(stdout);
  } catch (e) {
    console.error('Error inspecting all containers:', e);
    return [];
  }
}

export async function getPodmanPs(connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
    const { stdout } = await executor.exec(`podman ps -a --pod --format json`);
    const containers = JSON.parse(stdout);
    return containers.map((c: any) => {
        const names: string[] = Array.isArray(c.Names) ? c.Names : [];
        const normalizedNames = names.map(name => (typeof name === 'string' && name.startsWith('/')) ? name.slice(1) : String(name || ''));
        const hasInfraName = normalizedNames.some(name => name.includes('-infra'));
        const imageName = typeof c.Image === 'string' ? c.Image.toLowerCase() : '';
        const isPause = imageName.includes('podman-pause');
        if (hasInfraName || isPause) {
            c.isInfra = true;
        }
        return c;
    });
  } catch (e) {
    console.error('Error fetching podman ps:', e);
    return [];
  }
}

export async function getAllSystemServices(connection?: PodmanConnection) {
  const executor = getExecutor(connection);
  try {
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

        const map = new Map<number, any[]>();
        const targetPids = new Set(pids);

        console.log(`[HostPorts] Scanning for PIDs (and children): [${pids.join(', ')}]`);

        stdout.split('\n').forEach(line => {
             const parts = line.trim().split(/\s+/);
             if (parts.length < 5) return;

             const protocol = parts[0];
             const localAddr = parts[4];
             const processField = parts.slice(6).join(' ');

             const pidMatches = processField.matchAll(/pid=(\d+)/g);
             for (const match of pidMatches) {
                 const foundPid = parseInt(match[1]);

                 let assignedPid = -1;

                 if (targetPids.has(foundPid)) {
                     assignedPid = foundPid;
                 } else {
                     let current = foundPid;
                     let depth = 0;
                     while (parentMap.has(current) && depth < 10) {
                         const parent = parentMap.get(current)!;
                         if (targetPids.has(parent)) {
                             assignedPid = parent;
                             break;
                         }
                         if (parent <= 1) break;
                         current = parent;
                         depth++;
                     }
                 }

                 if (assignedPid !== -1) {
                     const lastColon = localAddr.lastIndexOf(':');
                     const ipStr = localAddr.substring(0, lastColon).replace('[', '').replace(']', '');
                     const port = parseInt(localAddr.substring(lastColon + 1));

                     const hostIp = (ipStr === '*' || ipStr === '') ? '0.0.0.0' : ipStr;

                     const portInfo = {
                         hostIp: hostIp,
                         containerPort: port,
                         hostPort: port,
                         protocol: protocol
                     };

                     const existing = map.get(assignedPid) || [];
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

        map.forEach((ports, pid) => console.log(`[HostPorts] PID ${pid} found ports: ${ports.length}`));

        return map;
    } catch (e) {
        console.warn('Failed to get host ports', e);
        return new Map<number, any[]>();
    }
}
