'use server';

import { exec } from 'child_process';
import { promisify } from 'util';
import { getExecutor } from '@/lib/executor';
import { listNodes, PodmanConnection } from '@/lib/nodes';

const execAsync = promisify(exec);

export async function getNodes() {
  return await listNodes();
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
