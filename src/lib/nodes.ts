import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PodmanConnection {
  Name: string;
  URI: string;
  Identity: string;
  Default: boolean;
}

export async function listNodes(): Promise<PodmanConnection[]> {
  try {
    const { stdout } = await execAsync('podman system connection list --format json');
    if (!stdout.trim()) return [];
    return JSON.parse(stdout);
  } catch (error) {
    console.error('Failed to list podman connections:', error);
    return [];
  }
}

export async function addNode(name: string, destination: string, identity?: string): Promise<void> {
  let cmd = `podman system connection add ${name} ${destination}`;
  if (identity) {
    cmd += ` --identity ${identity}`;
  }
  await execAsync(cmd);
}

export async function removeNode(name: string): Promise<void> {
  await execAsync(`podman system connection remove ${name}`);
}

export async function setDefaultNode(name: string): Promise<void> {
  await execAsync(`podman system connection default ${name}`);
}
