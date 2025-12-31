'use server';

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

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

export async function getSystemInfo(): Promise<SystemInfo> {
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

export async function getDiskUsage(): Promise<DiskInfo[]> {
  try {
    const { stdout } = await execAsync('df -h --output=source,size,used,avail,pcent,target');
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

export async function getSystemUpdates(): Promise<{ count: number; list: string[] }> {
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
  } catch (e) {
    // Fallback or ignore if not supported
    return { count: 0, list: [] };
  }
}
