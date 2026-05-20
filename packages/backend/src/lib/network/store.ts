import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '../dirs';
import { atomicWriteFile } from '../util/atomicWrite';

const STORE_PATH = path.join(DATA_DIR, 'network-edges.json');

export interface ManualEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  port?: number;
  created_at: string;
}

/**
 * Per-process serialization for edge mutations. addEdge/removeEdge
 * do an async read-modify-write — without the lock, concurrent calls
 * race: both read state X, both compute X±edge, both write — second
 * write clobbers the first's update. Same pattern as the config
 * mutex; see lib/config.ts.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => undefined);
  return next;
}

export class NetworkStore {
  static async getEdges(): Promise<ManualEdge[]> {
    try {
      const content = await fs.readFile(STORE_PATH, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  static async addEdge(edge: ManualEdge): Promise<void> {
    return withLock(async () => {
      const edges = await this.getEdges();
      // Avoid duplicates
      if (!edges.find(e => e.source === edge.source && e.target === edge.target)) {
        edges.push(edge);
        await this.saveEdges(edges);
      }
    });
  }

  static async removeEdge(id: string): Promise<void> {
    return withLock(async () => {
      const edges = await this.getEdges();
      const filtered = edges.filter(e => e.id !== id);
      await this.saveEdges(filtered);
    });
  }

  private static async saveEdges(edges: ManualEdge[]): Promise<void> {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    // Use atomicWriteFile so a crash mid-save can't corrupt the file
    // (writes a temp + rename). The previous fs.writeFile would
    // truncate the file before refilling, leaving an empty edge list
    // on disk if the process died at the wrong moment.
    await atomicWriteFile(STORE_PATH, JSON.stringify(edges, null, 2));
  }
}