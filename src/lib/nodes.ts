import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from './config';

const NODES_FILE = path.join(DATA_DIR, 'nodes.json');

export interface PodmanConnection {
  Name: string;
  URI: string;
  Identity: string;
  Default: boolean;
}

async function ensureDataDir() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function loadNodes(): Promise<PodmanConnection[]> {
  try {
    await ensureDataDir();
    // Check if file exists first to avoid exception spam
    try {
        await fs.access(NODES_FILE);
    } catch {
        return [];
    }

    const content = await fs.readFile(NODES_FILE, 'utf-8');
    let nodes: PodmanConnection[] = JSON.parse(content);

    // V4 Auto-Migration: Convert legacy "Host" SSH config to "Local" spawn config
    let migrated = false;
    nodes = nodes.map(node => {
        const isLegacyHost = (node.Name === 'Host' || node.Name === 'Local') && 
                             node.URI.startsWith('ssh://') && 
                             (node.Identity.includes('id_rsa') || node.URI.includes('@localhost') || node.URI.includes('@127.0.0.1'));
        
        if (isLegacyHost) {
             console.log(`[Migration] Updating legacy node '${node.Name}' to use Local Spawn...`);
             migrated = true;
             return {
                 ...node,
                 Name: 'Local',
                 URI: 'local',
                 Identity: ''
             };
        }
        return node;
    });

    if (migrated) {
        // We can't call saveNodes here comfortably if it causes recursive issues or hoisting, 
        // but since we are inside an async function executing at runtime, saveNodes (hoisted) is fine.
        await fs.writeFile(NODES_FILE, JSON.stringify(nodes, null, 2), 'utf-8');
    }

    return nodes;
  } catch (error) {
    console.error('Failed to load nodes:', error);
    return [];
  }
}

async function saveNodes(nodes: PodmanConnection[]) {
  await ensureDataDir();
  await fs.writeFile(NODES_FILE, JSON.stringify(nodes, null, 2), 'utf-8');
}

export async function listNodes(): Promise<PodmanConnection[]> {
  return loadNodes();
}

export async function addNode(name: string, destination: string, identity?: string): Promise<void> {
  const nodes = await loadNodes();
  if (nodes.find(n => n.Name === name)) {
      throw new Error(`Node ${name} already exists`);
  }
  
  // Format matching Podman's structure locally so frontend doesn't break
  const newNode: PodmanConnection = {
      Name: name,
      URI: destination,
      Identity: identity || '',
      Default: nodes.length === 0 // First node is default
  };
  
  nodes.push(newNode);
  await saveNodes(nodes);
}

export async function verifyNodeConnection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
        const nodes = await loadNodes();
        const node = nodes.find(n => n.Name === name);
        if (!node) {
            throw new Error(`Node ${name} not found`);
        }

        // Use Executor to verify connection
        // Dynamic import to avoid circular dependency (nodes -> executor -> agent -> handler -> nodes)
        const { getExecutor } = await import('./executor');
        const executor = getExecutor(node);
        // We run 'podman info' remotely to verify both SSH access and Podman installation
        await executor.exec('podman info'); 
        
        return { success: true };
    } catch (e) {
        console.warn(`Connection check failed for node ${name}:`, e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        return { success: false, error: errorMessage };
    }
}

export async function removeNode(name: string): Promise<void> {
  let nodes = await loadNodes();
  nodes = nodes.filter(n => n.Name !== name);
  
  // If we removed the default node, make the first one default if exists
  if (nodes.length > 0 && !nodes.some(n => n.Default)) {
      nodes[0].Default = true;
  }
  
  await saveNodes(nodes);
}

export async function setDefaultNode(name: string): Promise<void> {
  const nodes = await loadNodes();
  let found = false;
  
  for (const node of nodes) {
      if (node.Name === name) {
          node.Default = true;
          found = true;
      } else {
          node.Default = false;
      }
  }
  
  if (!found) {
    throw new Error(`Node ${name} not found`);
  }
  
  await saveNodes(nodes);
}

export async function getNodeConnection(name?: string): Promise<PodmanConnection | undefined> {
  if (!name || name === 'local') return undefined; // 'local' is reserved/internal
  const nodes = await loadNodes();
  return nodes.find(n => n.Name === name);
}
