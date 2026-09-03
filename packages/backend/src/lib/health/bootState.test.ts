/**
 * boot-state store — versioned adoption (#2739).
 *
 * The digest reads this file across a restart, so the two cases that matter on
 * a real box are: the pre-adoption (unversioned) file still loads, and a file
 * written by a newer ServiceBay is not silently reset by the 60 s heartbeat.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-boot-state-${process.pid}`),
}));

const TEST_DIR = path.join(os.tmpdir(), `sb-boot-state-${process.pid}`);
const FILE = path.join(TEST_DIR, 'boot-state.json');

import { readBootState, writeBootState } from './bootState';

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.rmSync(FILE, { force: true });
});

describe('bootState store', () => {
  it('returns {} on first boot', () => {
    expect(readBootState()).toEqual({});
  });

  it('reads the pre-adoption unversioned file a box already has', () => {
    fs.writeFileSync(FILE, JSON.stringify({ lastSeenVersion: '5.24.0', lastSeenAt: 1700 }));

    expect(readBootState()).toEqual({ lastSeenVersion: '5.24.0', lastSeenAt: 1700 });
  });

  it('re-stamps the file at version 1 on the next heartbeat', () => {
    fs.writeFileSync(FILE, JSON.stringify({ lastSeenVersion: '5.24.0' }));

    writeBootState({ ...readBootState(), lastSeenAt: 42 });

    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    expect(onDisk.__store).toBe('boot-state');
    expect(onDisk.version).toBe(1);
    expect(onDisk.data).toEqual({ lastSeenVersion: '5.24.0', lastSeenAt: 42 });
  });

  it('degrades to {} for a byte-corrupt file', () => {
    fs.writeFileSync(FILE, 'not json at all');

    expect(readBootState()).toEqual({});
  });

  it('refuses a newer file rather than overwriting it with a heartbeat', () => {
    const newer = JSON.stringify({ __store: 'boot-state', version: 2, data: { lastSeenAt: 9 } });
    fs.writeFileSync(FILE, newer);

    expect(() => readBootState()).toThrow(/only understands version 1/);
    expect(() => writeBootState({ lastSeenAt: 1 })).toThrow(/only understands version 1/);
    expect(fs.readFileSync(FILE, 'utf-8')).toBe(newer);
  });
});
