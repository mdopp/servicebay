import path from 'path';
import { z } from 'zod';
import { DATA_DIR } from '../dirs';
import { defineStore } from '../store/defineStore';

const STORE_PATH = () => path.join(DATA_DIR, 'network-edges.json');

const ManualEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  /**
   * `null` is tolerated as well as absent: the `POST /api/network/edges` route
   * derives the port with `parseInt`, and a non-numeric body field lands as
   * `NaN` — which `JSON.stringify` writes as `null`. Refusing it on read would
   * turn a sloppy request into a store that no longer loads.
   */
  port: z.number().nullish(),
  created_at: z.string(),
});

export type ManualEdge = z.infer<typeof ManualEdgeSchema>;

/**
 * Operator-drawn edges on the network graph (#2739 adoption).
 *
 * Version 1 is the first versioned shape. `migrations[1]` describes what every
 * existing box has on disk: a bare `ManualEdge[]` array with no envelope, from
 * before `defineStore` existed. A non-array (an empty or hand-mangled file)
 * migrates to an empty list rather than failing the schema, matching the
 * "missing/corrupt file reads back as no edges" behaviour this store has always
 * had.
 */
const edgeStore = defineStore<ManualEdge[]>({
  name: 'network-edges',
  file: STORE_PATH,
  version: 1,
  schema: z.array(ManualEdgeSchema),
  migrations: {
    1: previous => (Array.isArray(previous) ? previous : []),
  },
  fallback: () => [],
});

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
    return edgeStore.read();
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

  /**
   * Writes go through the versioned store, which stamps the envelope and hands
   * the body to `atomicWriteFile` (tmp → fsync → rename, #2414) so a crash
   * mid-save can't truncate the operator's edges — and refuses to overwrite a
   * file a newer ServiceBay wrote.
   */
  private static async saveEdges(edges: ManualEdge[]): Promise<void> {
    await edgeStore.write(edges);
  }
}
