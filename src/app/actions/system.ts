'use server';

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { getExecutor, Executor } from '@/lib/executor';
import { listNodes, PodmanConnection } from '@/lib/nodes';

const execAsync = promisify(exec);

export async function getNodes() {
  return await listNodes();
}

export interface SystemInfo {
  cpu: {
    model: string;
    cores: number;
    load: number[];
  };
  memory: {
    total: number;
    free: number;
  };
  os: {
    platform: string;
    release: string;
    hostname: string;
    uptime: number;
  };
  network: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

export interface DiskInfo {
  fs: string;
  size: string;
  used: string;
  avail: string;
  use: string;
  mount: string;
}

async function getRemoteSystemInfo(executor: Executor): Promise<SystemInfo> {
    try {
        const [uptimeOut, freeOut, hostnameOut, unameOut, lscpuOut, procUptimeOut] = await Promise.all([
            executor.exec('uptime'),
            executor.exec('free -b'),
            executor.exec('hostname'),
            executor.exec('uname -sr'),
            executor.exec('lscpu'),
            executor.exec('cat /proc/uptime')
        ]);

        // Parse load average
        const loadMatch = uptimeOut.stdout.match(/load average: (.+)/);
        const load = loadMatch ? loadMatch[1].split(',').map(s => parseFloat(s.trim())) : [0, 0, 0];
        
        // Parse uptime
        const uptime = parseFloat(procUptimeOut.stdout.split(' ')[0]);

        // Parse memory
        const memLines = freeOut.stdout.split('\n');
        const memValues = memLines[1]?.match(/\d+/g);
        const totalMem = memValues ? parseInt(memValues[0]) : 0;
        const freeMem = memValues ? parseInt(memValues[2]) : 0; // Using 'free' column
        
        // Parse CPU
        const modelName = lscpuOut.stdout.match(/Model name:\s+(.+)/)?.[1] || 'Unknown';
        const cpus = parseInt(lscpuOut.stdout.match(/CPU\(s\):\s+(\d+)/)?.[1] || '1');

        return {
            cpu: {
                model: modelName,
                cores: cpus,
                load: load
            },
            memory: {
                total: totalMem,
                free: freeMem
            },
            os: {
                platform: 'linux',
                release: unameOut.stdout.trim(),
                hostname: hostnameOut.stdout.trim(),
                uptime: uptime
            },
            network: {} // Network info omitted for remote
        };
    } catch (error) {
        console.error('Failed to fetch remote system info:', error);
        throw error;
    }
}

export async function getSystemInfo(nodeName?: string): Promise<SystemInfo> {
  if (!nodeName || nodeName === 'Local') {
      return {
        cpu: {
          model: os.cpus()[0].model,
          cores: os.cpus().length,
          load: os.loadavg(),
        },
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
        },
        os: {
          platform: os.platform(),
          release: os.release(),
          hostname: os.hostname(),
          uptime: os.uptime(),
        },
        network: os.networkInterfaces(),
      };
  }

  const nodes = await listNodes();
  const node = nodes.find(n => n.Name === nodeName);
  if (!node) throw new Error(`Node ${nodeName} not found`);

  const executor = getExecutor(node);
  return getRemoteSystemInfo(executor);
}

export async function getDiskUsage(nodeName?: string): Promise<DiskInfo[]> {
  let executor: Executor;
  
  if (!nodeName || nodeName === 'Local') {
      executor = getExecutor(); // LocalExecutor
  } else {
      const nodes = await listNodes();
      const node = nodes.find(n => n.Name === nodeName);
      if (!node) throw new Error(`Node ${nodeName} not found`);
      executor = getExecutor(node);
  }

  try {
    const { stdout } = await executor.exec('df -h --output=source,size,used,avail,pcent,target');
    const lines = stdout.trim().split('\n').slice(1); // Skip header
    return lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        fs: parts[0],
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        use: parts[4],
        mount: parts[5],
      };
    }).filter(d => d.fs.startsWith('/dev/') || d.mount === '/'); // Filter for physical disks or root
  } catch (e) {
    console.error('Error fetching disk usage:', e);
    return [];
  }
}

export async function getSystemUpdates(nodeName?: string): Promise<{ count: number; list: string[] }> {
  if (nodeName && nodeName !== 'Local') {
      return { count: 0, list: [] };
  }

  try {
    // This is highly OS dependent. Assuming Debian/Ubuntu based on previous context.
    // 'apt list --upgradable' might be slow or require sudo for 'apt update'.
    // We'll try a safe check.
    const { stdout } = await execAsync('apt list --upgradable 2>/dev/null | grep -v "Listing..." | wc -l');
    const count = parseInt(stdout.trim()) || 0;
    
    // Get list if count > 0
    let list: string[] = [];
    if (count > 0) {
        const { stdout: listOut } = await execAsync('apt list --upgradable 2>/dev/null | grep -v "Listing..." | head -n 10');
        list = listOut.trim().split('\n');
    }
    
    return { count, list };
  } catch {
    // Fallback or ignore if not supported
    return { count: 0, list: [] };
  }
}

export async function readFileContent(path: string, nodeName?: string): Promise<string> {
  let connection: PodmanConnection | undefined;
  if (nodeName && nodeName !== 'Local') {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
      if (!connection) {
          throw new Error(`Node ${nodeName} not found`);
      }
  }
  const executor = getExecutor(connection);
  try {
    return await executor.readFile(path);
  } catch (error) {
    console.error(`Error reading file ${path}:`, error);
    throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
  }
}
