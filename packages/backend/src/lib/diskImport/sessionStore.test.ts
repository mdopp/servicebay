/**
 * Durable disk-import session store (#1896).
 *
 * Mirrors the jobStore persistence contract: a reviewed scan plan is written
 * to its own atomic state file under DATA_DIR + an append-only log, survives a
 * simulated backend restart (re-read from a fresh store reference), the apply
 * reference is one-shot (markApplied), and old sessions are pruned to
 * KEEP_RECENT.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

// Real-fs path scoped to this process so we exercise the actual atomic
// write/read/prune logic (no fs mock), mirroring jobStore.race.test.ts.
vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-diskimport-store-${process.pid}`),
}));

const TEST_DIR = path.join(os.tmpdir(), `sb-diskimport-store-${process.pid}`);
const SESSIONS_DIR = path.join(TEST_DIR, 'disk-import-sessions');

import {
  createSession,
  createScanJob,
  finalizeScan,
  updateSession,
  setProgress,
  markApplying,
  markError,
  markCrashedOnStartup,
  getSession,
  getSessionStatus,
  abortSession,
  markApplied,
  sessionHashes,
  appendLog,
  readLog,
  STALE_AFTER_MS,
  MAX_TREE_NODES,
  __clearSessions,
} from './sessionStore';
import type { ImportPlan } from '@servicebay/disk-import-worker';

function mkPlan(sourcePath = '/mnt/docs/report.pdf'): ImportPlan {
  return {
    items: [
      {
        record: { sourcePath, size: 10, mtimeMs: 1700000000000, ext: 'pdf', name: 'report.pdf' },
        category: 'documents',
        target: 'documents/report.pdf',
        action: 'copy',
      },
    ],
    conflicts: [],
  };
}

beforeEach(async () => {
  await __clearSessions();
});

afterEach(async () => {
  await __clearSessions();
});

describe('createSession + getSession (persistence)', () => {
  it('persists a reviewed session to its own state file and reads it back intact', async () => {
    const plan = mkPlan();
    const hashes = new Map([['/mnt/docs/report.pdf', 'a'.repeat(64)]]);
    await createSession({ id: 'sess-1', device: '/dev/sda1', plan, hashes, catalogPath: ':memory:' });

    // The state file exists on disk (its own per-session file).
    await expect(fs.stat(path.join(SESSIONS_DIR, 'sess-1.json'))).resolves.toBeTruthy();

    const got = await getSession('sess-1');
    expect(got).not.toBeNull();
    expect(got!.device).toBe('/dev/sda1');
    expect(got!.phase).toBe('reviewed');
    expect(got!.plan!.items[0].target).toBe('documents/report.pdf');
    expect(sessionHashes(got!).get('/mnt/docs/report.pdf')).toBe('a'.repeat(64));
  });

  it('returns null for an unknown / forged session id (the review gate)', async () => {
    expect(await getSession('forged')).toBeNull();
  });
});

describe('restart survival', () => {
  it('a session created then re-read from a fresh store module instance is intact', async () => {
    const plan = mkPlan('/mnt/music/track.flac');
    const hashes = new Map([['/mnt/music/track.flac', 'b'.repeat(64)]]);
    await createSession({ id: 'sess-restart', device: '/dev/sdb1', plan, hashes, catalogPath: '/tmp/cat.db' });

    // Simulate a backend restart: drop the module cache so the next import is
    // a fresh process-equivalent module (cold caches, new PROCESS_STARTED_AT).
    vi.resetModules();
    const fresh = await import('./sessionStore');

    const got = await fresh.getSession('sess-restart');
    expect(got).not.toBeNull();
    expect(got!.device).toBe('/dev/sdb1');
    expect(got!.catalogPath).toBe('/tmp/cat.db');
    expect(got!.plan!.items[0].record.sourcePath).toBe('/mnt/music/track.flac');
    expect(fresh.sessionHashes(got!).get('/mnt/music/track.flac')).toBe('b'.repeat(64));
  });
});

describe('markApplied (one apply per review)', () => {
  it('flips phase to applied so the apply gate refuses a second apply', async () => {
    await createSession({
      id: 'sess-apply',
      device: '/dev/sda1',
      plan: mkPlan(),
      hashes: new Map(),
      catalogPath: ':memory:',
    });
    const applied = await markApplied('sess-apply');
    expect(applied!.phase).toBe('applied');
    expect((await getSession('sess-apply'))!.phase).toBe('applied');
  });

  it('returns null when the session is gone', async () => {
    expect(await markApplied('nope')).toBeNull();
  });
});

describe('append/readLog', () => {
  it('appends lines and reads them back from an offset', async () => {
    await createSession({
      id: 'sess-log',
      device: '/dev/sda1',
      plan: mkPlan(),
      hashes: new Map(),
      catalogPath: ':memory:',
    });
    await appendLog('sess-log', 'scanning');
    await appendLog('sess-log', 'done');
    const { content, nextOffset } = await readLog('sess-log');
    expect(content).toBe('scanning\ndone\n');
    expect(nextOffset).toBeGreaterThan(0);
    // Catch-up read from the offset returns nothing new.
    expect((await readLog('sess-log', nextOffset)).content).toBe('');
  });
});

describe('async job lifecycle (#1897)', () => {
  it('createScanJob opens a scanning job with no plan; finalizeScan attaches the plan + flips to reviewed', async () => {
    await createScanJob({ id: 'job-1', device: '/dev/sda1', catalogPath: ':memory:' });
    const opened = await getSession('job-1');
    expect(opened!.phase).toBe('scanning');
    expect(opened!.plan).toBeUndefined();
    expect(opened!.progress.step).toBe('mount');

    const plan = mkPlan();
    const hashes = new Map([['/mnt/docs/report.pdf', 'd'.repeat(64)]]);
    await finalizeScan('job-1', { plan, hashes });
    const reviewed = await getSession('job-1');
    expect(reviewed!.phase).toBe('reviewed');
    expect(reviewed!.plan!.items[0].target).toBe('documents/report.pdf');
    expect(sessionHashes(reviewed!).get('/mnt/docs/report.pdf')).toBe('d'.repeat(64));
    expect(reviewed!.progress.scanned).toBe(1);
  });

  it('setProgress patches live counters; markApplying / markError flip phase', async () => {
    await createScanJob({ id: 'job-2', device: '/dev/sda1', catalogPath: ':memory:' });
    await setProgress('job-2', { step: 'hash', scanned: 120, hashed: 40, total: 60 });
    let s = await getSession('job-2');
    expect(s!.progress).toMatchObject({ step: 'hash', scanned: 120, hashed: 40, total: 60 });

    await markApplying('job-2');
    s = await getSession('job-2');
    expect(s!.phase).toBe('applying');
    expect(s!.progress.step).toBe('copy');

    await markError('job-2', 'rsync blew up');
    s = await getSession('job-2');
    expect(s!.phase).toBe('error');
    expect(s!.error).toBe('rsync blew up');
  });

  it('markApplied records the written count; updateSession is a no-op on a gone session', async () => {
    await createSession({ id: 'job-3', device: '/dev/sda1', plan: mkPlan(), hashes: new Map(), catalogPath: ':memory:' });
    const applied = await markApplied('job-3', 7);
    expect(applied!.phase).toBe('applied');
    expect(applied!.applied).toBe(7);
    expect(await updateSession('ghost', { phase: 'error' })).toBeNull();
  });

  it('markCrashedOnStartup flips mid-flight jobs to error, leaves terminal ones alone', async () => {
    await createScanJob({ id: 'crash-scan', device: '/dev/sda1', catalogPath: ':memory:' }); // scanning
    await createScanJob({ id: 'crash-apply', device: '/dev/sda1', catalogPath: ':memory:' });
    await markApplying('crash-apply'); // applying
    await createSession({ id: 'survivor', device: '/dev/sda1', plan: mkPlan(), hashes: new Map(), catalogPath: ':memory:' }); // reviewed

    const n = await markCrashedOnStartup();
    expect(n).toBe(2);
    expect((await getSession('crash-scan'))!.phase).toBe('error');
    expect((await getSession('crash-apply'))!.phase).toBe('error');
    expect((await getSession('survivor'))!.phase).toBe('reviewed');
  });
});

describe('store split — compact status doc vs bulk sidecar (#1945)', () => {
  it('writes the plan/hashes to a SIDECAR; the status doc carries no records', async () => {
    const plan = mkPlan('/mnt/docs/a.pdf');
    const hashes = new Map([['/mnt/docs/a.pdf', 'a'.repeat(64)]]);
    await createSession({ id: 'split-1', device: '/dev/sda1', plan, hashes, catalogPath: ':memory:' });

    // The bulk sidecar exists and holds the records.
    const sidecarRaw = await fs.readFile(path.join(SESSIONS_DIR, 'split-1.plan.json'), 'utf-8');
    expect(JSON.parse(sidecarRaw).plan.items[0].record.sourcePath).toBe('/mnt/docs/a.pdf');

    // The compact status doc on disk does NOT inline the plan or hashes.
    const statusRaw = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, 'split-1.json'), 'utf-8'));
    expect(statusRaw.plan).toBeUndefined();
    expect(statusRaw.hashes).toBeUndefined();
  });

  it('getSessionStatus reads ONLY the compact doc (no plan/hashes); getSession rehydrates them', async () => {
    const plan = mkPlan('/mnt/docs/a.pdf');
    const hashes = new Map([['/mnt/docs/a.pdf', 'a'.repeat(64)]]);
    await createSession({
      id: 'split-2',
      device: '/dev/sda1',
      plan,
      hashes,
      catalogPath: ':memory:',
      summary: {
        totalFiles: 1,
        totalBytes: 10,
        categories: [],
        actions: [],
        tree: [],
        boxUsers: [],
        defaultOwner: 'shared',
      },
    });

    const compact = await getSessionStatus('split-2');
    expect(compact!.phase).toBe('reviewed');
    expect(compact!.plan).toBeUndefined(); // never loads the sidecar
    expect(compact!.summary!.totalFiles).toBe(1);

    const full = await getSession('split-2');
    expect(full!.plan!.items[0].record.sourcePath).toBe('/mnt/docs/a.pdf'); // rehydrated
    expect(sessionHashes(full!).get('/mnt/docs/a.pdf')).toBe('a'.repeat(64));
  });

  it('caps the persisted routing tree to MAX_TREE_NODES (#1945)', async () => {
    const tree = Array.from({ length: MAX_TREE_NODES + 50 }, (_, i) => ({ dir: `d${i}` }));
    await createScanJob({ id: 'cap-1', device: '/dev/sda1', catalogPath: ':memory:' });
    await finalizeScan('cap-1', {
      plan: mkPlan(),
      hashes: new Map(),
      summary: { totalFiles: 1, totalBytes: 0, categories: [], actions: [], tree, boxUsers: [], defaultOwner: 'shared' },
    });
    const s = await getSessionStatus('cap-1');
    expect(s!.summary!.tree.length).toBe(MAX_TREE_NODES);
    expect(s!.summary!.treeTruncated).toBe(true);
  });
});

describe('liveness / zombie reaping (#1943)', () => {
  it('setProgress refreshes the heartbeat', async () => {
    await createScanJob({ id: 'hb-1', device: '/dev/sda1', catalogPath: ':memory:' });
    const before = (await getSessionStatus('hb-1'))!.heartbeat!;
    await new Promise(r => setTimeout(r, 5));
    await setProgress('hb-1', { step: 'walk', scanned: 10 });
    const after = (await getSessionStatus('hb-1'))!.heartbeat!;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('reaps a non-terminal session with a stale heartbeat to error on read', async () => {
    await createScanJob({ id: 'zombie-1', device: '/dev/sda1', catalogPath: ':memory:' });
    // Backdate the heartbeat past the stale window (simulate a dead worker).
    const stale = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    await updateSession('zombie-1', { heartbeat: stale });
    // It was `scanning`; now a status read flips it to error.
    const s = await getSessionStatus('zombie-1');
    expect(s!.phase).toBe('error');
    expect(s!.error).toMatch(/interrupted/i);
  });

  it('does NOT reap a fresh in-flight session', async () => {
    await createScanJob({ id: 'alive-1', device: '/dev/sda1', catalogPath: ':memory:' });
    const s = await getSessionStatus('alive-1');
    expect(s!.phase).toBe('scanning');
  });

  it('abortSession flips a stuck session terminal; idempotent on a terminal one', async () => {
    await createScanJob({ id: 'abort-1', device: '/dev/sda1', catalogPath: ':memory:' });
    const aborted = await abortSession('abort-1');
    expect(aborted!.phase).toBe('error');
    expect(aborted!.error).toMatch(/start a new scan/i);
    // Idempotent: a second abort leaves it terminal, doesn't re-message.
    const again = await abortSession('abort-1');
    expect(again!.phase).toBe('error');
    expect(await abortSession('ghost')).toBeNull();
  });

  it('markCrashedOnStartup also reaps an already-stale same-process zombie', async () => {
    await createScanJob({ id: 'crash-stale', device: '/dev/sda1', catalogPath: ':memory:' });
    // A scanning job is flipped regardless; verify a non-terminal stale one too.
    const n = await markCrashedOnStartup();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await getSessionStatus('crash-stale'))!.phase).toBe('error');
  });
});

describe('prune to KEEP_RECENT', () => {
  it('keeps only the most-recent sessions, dropping older state + log files', async () => {
    // KEEP_RECENT_SESSIONS is 20; create 23 so 3 of the oldest get pruned on
    // the later createSession calls. createdAt is ISO-second granularity, so
    // stamp distinct createdAt values to make "most recent" deterministic.
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const id = `prune-${String(i).padStart(2, '0')}`;
      ids.push(id);
      await createSession({
        id,
        device: '/dev/sda1',
        plan: mkPlan(),
        hashes: new Map(),
        catalogPath: ':memory:',
      });
      // Rewrite createdAt so ordering is strictly by index (writes are too
      // fast to differ at second granularity otherwise).
      const p = path.join(SESSIONS_DIR, `${id}.json`);
      const raw = JSON.parse(await fs.readFile(p, 'utf-8'));
      raw.createdAt = new Date(1700000000000 + i * 1000).toISOString();
      await fs.writeFile(p, JSON.stringify(raw));
    }

    // prune runs at the START of each createSession (before the new write),
    // exactly like jobStore — so after the last create the count is keep + the
    // just-written one (21), and the oldest beyond keep are gone. Count only the
    // compact status docs (#1945 split: each session also has a `.plan.json`
    // sidecar, which must NOT be miscounted as a status doc).
    const remaining = (await fs.readdir(SESSIONS_DIR)).filter(
      f => f.endsWith('.json') && !f.endsWith('.plan.json'),
    );
    expect(remaining.length).toBeLessThanOrEqual(21);
    // The oldest are pruned; the newest survive (and so are their log + sidecar files).
    expect(await getSession('prune-00')).toBeNull();
    expect(await getSession('prune-22')).not.toBeNull();
    await expect(fs.stat(path.join(SESSIONS_DIR, 'prune-00.log'))).rejects.toThrow();
    // The bulk plan sidecar is pruned alongside the status doc (#1945).
    await expect(fs.stat(path.join(SESSIONS_DIR, 'prune-00.plan.json'))).rejects.toThrow();
  });
});
