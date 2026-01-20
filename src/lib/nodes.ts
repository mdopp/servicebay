import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from './dirs';

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
        const defaultNode = buildDefaultLocalNode();
        await saveNodes([defaultNode]);
        return [defaultNode];
    }

    const content = await fs.readFile(NODES_FILE, 'utf-8');
    let nodes: PodmanConnection[] = JSON.parse(content);

    // V4 Auto-Migration: Convert legacy "Host" SSH config to "Local" spawn config
    const migrated = false;
    nodes = nodes.map(node => {
        // Disabled migration: We prefer SSH for Local node in containerized environments (Quadlet)
        // unless explicitly set to 'local'.
        // The previous logic forced 'local' URI which broke container->host management via SSH.
        /*
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
        */
        return node;
    });

      if (nodes.length === 0) {
        const defaultNode = buildDefaultLocalNode();
        nodes = [defaultNode];
        await saveNodes(nodes);
      }

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

function buildDefaultLocalNode(): PodmanConnection {
  const username = process.env.HOST_USER || process.env.USER || 'root';
  return {
    Name: 'Local',
    URI: `ssh://${username}@127.0.0.1`,
    Identity: '/app/data/ssh/id_rsa',
    Default: true
  };
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

export async function updateNode(oldName: string, newNode: Partial<PodmanConnection>): Promise<void> {
  const nodes = await loadNodes();
  const index = nodes.findIndex(n => n.Name === oldName);
  
  if (index === -1) {
    throw new Error(`Node ${oldName} not found`);
  }

  // Check name collision if name is changing
  if (newNode.Name && newNode.Name !== oldName && nodes.some(n => n.Name === newNode.Name)) {
      throw new Error(`Node name ${newNode.Name} already taken`);
  }

  nodes[index] = {
      ...nodes[index],
      ...newNode,
      // Ensure we don't accidentally unset Default if not provided
      Default: newNode.Default !== undefined ? newNode.Default : nodes[index].Default
  };
  
  await saveNodes(nodes);
}

export async function verifyNodeConnection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
        const nodes = await loadNodes();
        const node = nodes.find(n => n.Name === name);
        if (!node) {
            throw new Error(`Node ${name} not found`);
        }

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
  if (!name) return undefined;
  const nodes = await loadNodes();
  return nodes.find(n => n.Name === name);
}
