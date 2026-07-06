import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { parseCrashBreadcrumb, recoveryHintFor, RELABEL_HINT } from './crashBreadcrumb';

// The ExecStopPost writer (fedora-coreos.bu) produces this shape. Kept as the
// format contract so a writer-format change surfaces here as a test change.
const sampleRaw = {
  unit: 'servicebay.service',
  timestamp: '2026-07-06T21:30:00Z',
  service_result: 'exit-code',
  exit_code: 'exited',
  exit_status: '126',
  likely_cause: 'relabel-or-permission (exit 126): a foreign-owned stray ...',
  journal_tail: 'permission denied relabeling /app/data\nexit status 126',
};

describe('parseCrashBreadcrumb (#2159 format contract)', () => {
  it('parses a full breadcrumb and derives the relabel hint for exit 126', () => {
    const b = parseCrashBreadcrumb(JSON.stringify(sampleRaw));
    expect(b).not.toBeNull();
    expect(b!.unit).toBe('servicebay.service');
    expect(b!.timestamp).toBe('2026-07-06T21:30:00Z');
    expect(b!.serviceResult).toBe('exit-code');
    expect(b!.exitCode).toBe('exited');
    expect(b!.exitStatus).toBe('126');
    expect(b!.journalTail).toContain('exit status 126');
    // Exit 126 → the named relabel/permission recovery hint, not the raw cause.
    expect(b!.recoveryHint).toBe(RELABEL_HINT);
  });

  it('returns null for non-JSON and for non-object JSON', () => {
    expect(parseCrashBreadcrumb('not json')).toBeNull();
    expect(parseCrashBreadcrumb('[]')).toBeNull();
    expect(parseCrashBreadcrumb('"a string"')).toBeNull();
    expect(parseCrashBreadcrumb('42')).toBeNull();
  });

  it('fills unknowns for a partial write and defaults unit to servicebay.service', () => {
    const b = parseCrashBreadcrumb(JSON.stringify({ exit_status: '1' }));
    expect(b).not.toBeNull();
    expect(b!.unit).toBe('servicebay.service');
    expect(b!.timestamp).toBe('unknown');
    expect(b!.exitStatus).toBe('1');
    expect(b!.journalTail).toBe('');
  });
});

describe('recoveryHintFor', () => {
  it('maps exit 126 to the relabel/permission hint', () => {
    expect(recoveryHintFor('126')).toBe(RELABEL_HINT);
    expect(recoveryHintFor(' 126 ')).toBe(RELABEL_HINT);
  });

  it('prefers a writer-named cause over the generic hint for non-126', () => {
    expect(recoveryHintFor('137', 'OOM-killed')).toBe('OOM-killed');
  });

  it('falls back to the generic journal hint when no useful cause is present', () => {
    expect(recoveryHintFor('1', 'see journal_tail')).toContain('journal tail');
    expect(recoveryHintFor('1')).toContain('journal tail');
  });
});

describe('readCrashBreadcrumb (data-dir integration)', () => {
  let tmpDir: string;
  let readCrashBreadcrumb: typeof import('./crashBreadcrumb').readCrashBreadcrumb;
  let CRASH_BREADCRUMB_FILE: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crashbc-'));
    vi.resetModules();
    process.env.DATA_DIR = tmpDir;
    ({ readCrashBreadcrumb, CRASH_BREADCRUMB_FILE } = await import('./crashBreadcrumb'));
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no breadcrumb file exists (never crashed / pre-writer box)', () => {
    expect(readCrashBreadcrumb()).toBeNull();
  });

  it('reads and parses a written breadcrumb', async () => {
    await fs.writeFile(CRASH_BREADCRUMB_FILE, JSON.stringify(sampleRaw));
    const b = readCrashBreadcrumb();
    expect(b).not.toBeNull();
    expect(b!.exitStatus).toBe('126');
    expect(b!.recoveryHint).toBe(RELABEL_HINT);
  });

  it('returns null (never throws) on a corrupt breadcrumb file', async () => {
    await fs.writeFile(CRASH_BREADCRUMB_FILE, '{ corrupt');
    expect(readCrashBreadcrumb()).toBeNull();
  });
});
