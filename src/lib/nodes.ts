import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from './dirs';
import { atomicWriteFile } from './util/atomicWrite';

const NODES_FILE = path.join(DATA_DIR, 'nodes.json');

const normalizeName = (name: string) => name.trim().toLowerCase();

/**
 * Per-process serialization for node mutations. Without it, two
 * concurrent addNode/updateNode/removeNode calls race: both read
 * state X, both compute X±node, both write — the second clobbers
 * the first. Same pattern as updateConfig (#299) and NetworkStore
 * (#300). The mutex wraps any function that does an async
 * read-modify-write on NODES_FILE.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => undefined);
  return next;
}

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

      // Deduplicate nodes by name (case-insensitive) to avoid duplicate "Local" entries
      const deduped = new Map<string, PodmanConnection>();
      for (const node of nodes) {
        const key = normalizeName(node.Name);
        const existing = deduped.get(key);
        if (!existing) {
          deduped.set(key, node);
        } else {
          deduped.set(key, { ...existing, Default: existing.Default || node.Default });
        }
      }
      const dedupedNodes = Array.from(deduped.values());
      const dedupedChanged = dedupedNodes.length !== nodes.length;
      nodes = dedupedNodes;

      if (nodes.length === 0) {
        const defaultNode = buildDefaultLocalNode();
        nodes = [defaultNode];
        await saveNodes(nodes);
      }

      // Ensure exactly one default node remains
      let normalizedDefault = false;
      if (nodes.length > 0 && !nodes.some(n => n.Default)) {
        nodes[0].Default = true;
        normalizedDefault = true;
      }

      if (dedupedChanged || normalizedDefault) {
        // Same pattern as saveNodes — go through atomicWriteFile to
        // keep loadNodes' implicit save crash-safe with the rest.
        await atomicWriteFile(NODES_FILE, JSON.stringify(nodes, null, 2));
    }

    return nodes;
  } catch (error) {
    console.error('Failed to load nodes:', error);
    return [];
  }
}

async function saveNodes(nodes: PodmanConnection[]) {
  await ensureDataDir();
  // atomicWriteFile (temp + rename) so a crash mid-save can't leave
  // the file truncated. Previously fs.writeFile would zero the file
  // before refilling, leaving an empty nodes list on disk if the
  // process died between truncate and fill.
  await atomicWriteFile(NODES_FILE, JSON.stringify(nodes, null, 2));
}

function buildDefaultLocalNode(): PodmanConnection {
  const username = process.env.HOST_USER || process.env.USER || 'root';
  // In container mode the agent SSHs back to the host gateway, not to 127.0.0.1
  // (which inside the container is the container itself). HOST_SSH is set by
  // the runtime — `host.containers.internal` (podman) / `host.docker.internal`
  // (docker) for dev, or the configured host address in production.
  const host = process.env.HOST_SSH || '127.0.0.1';
  return {
    Name: 'Local',
    URI: `ssh://${username}@${host}`,
    Identity: '/app/data/ssh/id_rsa',
    Default: true
  };
}

export async function listNodes(): Promise<PodmanConnection[]> {
  return loadNodes();
}

export async function addNode(name: string, destination: string, identity?: string): Promise<void> {
  return withLock(async () => {
    const nodes = await loadNodes();
    const normalizedName = normalizeName(name);
    if (normalizedName === 'local') {
        throw new Error('The Local node is managed automatically and cannot be added again.');
    }
    if (nodes.find(n => normalizeName(n.Name) === normalizedName)) {
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
  });
}

export async function updateNode(oldName: string, newNode: Partial<PodmanConnection>): Promise<void> {
  return withLock(async () => {
    const nodes = await loadNodes();
    const normalizedOldName = normalizeName(oldName);
    const index = nodes.findIndex(n => normalizeName(n.Name) === normalizedOldName);

    if (index === -1) {
      throw new Error(`Node ${oldName} not found`);
    }

    // Check name collision if name is changing (case-insensitive)
    const targetName = newNode.Name ? normalizeName(newNode.Name) : normalizedOldName;
    if (targetName === 'local' && normalizedOldName !== 'local') {
      throw new Error('The Local node name is reserved.');
    }
    if (newNode.Name && nodes.some((n, idx) => idx !== index && normalizeName(n.Name) === targetName)) {
      throw new Error(`Node name ${newNode.Name} already taken`);
    }

    nodes[index] = {
        ...nodes[index],
        ...newNode,
        // Ensure we don't accidentally unset Default if not provided
        Default: newNode.Default !== undefined ? newNode.Default : nodes[index].Default
    };

    await saveNodes(nodes);
  });
}

export async function verifyNodeConnection(name: string): Promise<{ success: boolean; error?: string }> {
    try {
        const nodes = await loadNodes();
    const node = nodes.find(n => normalizeName(n.Name) === normalizeName(name));
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
  return withLock(async () => {
    let nodes = await loadNodes();
    const target = normalizeName(name);
    nodes = nodes.filter(n => normalizeName(n.Name) !== target);

    // If we removed the default node, make the first one default if exists
    if (nodes.length > 0 && !nodes.some(n => n.Default)) {
        nodes[0].Default = true;
    }

    await saveNodes(nodes);
  });
}

export async function setDefaultNode(name: string): Promise<void> {
  return withLock(async () => {
    const nodes = await loadNodes();
    let found = false;
    const target = normalizeName(name);

    for (const node of nodes) {
        if (normalizeName(node.Name) === target) {
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
  });
}

export async function getNodeConnection(name?: string): Promise<PodmanConnection | undefined> {
  if (!name) return undefined;
  const nodes = await loadNodes();
  const target = normalizeName(name);
  return nodes.find(n => normalizeName(n.Name) === target);
}
