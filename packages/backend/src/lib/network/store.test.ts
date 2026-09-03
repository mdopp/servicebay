 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-network-store-race-${process.pid}`),
}));

const TEST_DIR = path.join(os.tmpdir(), `sb-network-store-race-${process.pid}`);
const STORE_PATH = path.join(TEST_DIR, 'network-edges.json');

import { NetworkStore } from './store';

beforeEach(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.rm(STORE_PATH, { force: true });
});

const mkEdge = (id: string, source = `s-${id}`, target = `t-${id}`) => ({
  id,
  source,
  target,
  created_at: new Date().toISOString(),
});

describe('NetworkStore mutex', () => {
  it('does not lose edges from concurrent addEdge calls', async () => {
    // Without serialization, both adds would read [] and each save
    // a one-element array — second write clobbers the first.
    await Promise.all([
      NetworkStore.addEdge(mkEdge('a')),
      NetworkStore.addEdge(mkEdge('b')),
      NetworkStore.addEdge(mkEdge('c')),
    ]);
    const edges = await NetworkStore.getEdges();
    expect(edges.map(e => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('serializes add + remove correctly', async () => {
    await NetworkStore.addEdge(mkEdge('a'));
    await NetworkStore.addEdge(mkEdge('b'));
    // Remove 'a' while concurrently adding 'c' — both must land.
    await Promise.all([
      NetworkStore.removeEdge('a'),
      NetworkStore.addEdge(mkEdge('c')),
    ]);
    const edges = await NetworkStore.getEdges();
    expect(edges.map(e => e.id).sort()).toEqual(['b', 'c']);
  });

  it('skips duplicate source+target pairs', async () => {
    await NetworkStore.addEdge(mkEdge('a', 'X', 'Y'));
    await NetworkStore.addEdge(mkEdge('b', 'X', 'Y'));
    const edges = await NetworkStore.getEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('a');
  });
});

describe('NetworkStore versioned adoption (#2739)', () => {
  it('reads the pre-adoption bare array a box already has on disk', async () => {
    // What network-edges.json looks like on every box that upgraded into the
    // versioned store: no envelope, just the edges.
    await fs.writeFile(STORE_PATH, JSON.stringify([mkEdge('legacy')], null, 2));

    const edges = await NetworkStore.getEdges();
    expect(edges.map(e => e.id)).toEqual(['legacy']);
  });

  it('re-stamps that file at version 1 on the next write, keeping the data', async () => {
    await fs.writeFile(STORE_PATH, JSON.stringify([mkEdge('legacy')], null, 2));

    await NetworkStore.addEdge(mkEdge('fresh'));

    const onDisk = JSON.parse(await fs.readFile(STORE_PATH, 'utf-8'));
    expect(onDisk.__store).toBe('network-edges');
    expect(onDisk.version).toBe(1);
    expect(onDisk.data.map((e: { id: string }) => e.id).sort()).toEqual(['fresh', 'legacy']);
  });

  it('refuses a file written by a newer ServiceBay instead of resetting it', async () => {
    const newer = JSON.stringify({ __store: 'network-edges', version: 2, data: [] }, null, 2);
    await fs.writeFile(STORE_PATH, newer);

    await expect(NetworkStore.getEdges()).rejects.toThrow(/only understands version 1/);
    expect(await fs.readFile(STORE_PATH, 'utf-8')).toBe(newer);
  });
});
