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
    const { stdout } = await execAsync('podman system connection list --format json', { timeout: 5000 });
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
  // Set a timeout to prevent hanging if SSH prompts or network is slow
  await execAsync(cmd, { timeout: 15000 });
}

export async function verifyNodeConnection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Try to fetch info from the node with a strict timeout
        await execAsync(`podman --connection ${name} info`, { timeout: 5000 });
        return { success: true };
    } catch (e) {
        console.warn(`Connection check failed for node ${name}:`, e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        // Clean up the error message to be more user friendly if possible, or just return the raw stderr
        // execAsync error usually contains stdout and stderr
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stderr = (e as any).stderr || errorMessage;
        return { success: false, error: stderr };
    }
}

export async function removeNode(name: string): Promise<void> {
  await execAsync(`podman system connection remove ${name}`, { timeout: 5000 });
}

export async function setDefaultNode(name: string): Promise<void> {
  await execAsync(`podman system connection default ${name}`, { timeout: 5000 });
}

export async function getNodeConnection(name?: string): Promise<PodmanConnection | undefined> {
  if (!name || name === 'local') return undefined;
  const nodes = await listNodes();
  return nodes.find(n => n.Name === name);
}
