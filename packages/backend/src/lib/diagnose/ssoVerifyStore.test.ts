import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type { SsoVerifyReport } from '@/lib/diagnose/ssoVerify';

// Point DATA_DIR at a fresh temp dir BEFORE importing the store (dirs.ts
// reads process.env.DATA_DIR at module load).
let tmpDir: string;

const sampleReport = (over: Partial<SsoVerifyReport> = {}): SsoVerifyReport => ({
  ok: true,
  cleanedUp: true,
  ephemeralUser: 'sb-ssoverify-123-abc',
  steps: [{ id: 'create_user', status: 'pass', detail: 'created' }],
  userDomains: [{ domain: 'vault.example.com', status: 'pass', code: 200, detail: 'HTTP 200' }],
  adminDomains: [{ domain: 'nginx.example.com', status: 'pass', code: 302, detail: 'HTTP 302 (blocked)' }],
  ...over,
});

describe('ssoVerifyStore', () => {
  let store: typeof import('@/lib/diagnose/ssoVerifyStore');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssoverify-'));
    vi.resetModules();
    process.env.DATA_DIR = tmpDir;
    store = await import('@/lib/diagnose/ssoVerifyStore');
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no report has been saved yet', async () => {
    expect(await store.loadSsoVerifyReport()).toBeNull();
  });

  it('round-trips a saved report with a timestamp', async () => {
    const report = sampleReport();
    await store.saveSsoVerifyReport(report);
    const loaded = await store.loadSsoVerifyReport();
    expect(loaded).not.toBeNull();
    expect(loaded!.report).toEqual(report);
    expect(typeof loaded!.at).toBe('string');
    expect(Number.isNaN(Date.parse(loaded!.at))).toBe(false);
  });

  it('overwrites the previous report (single-slot)', async () => {
    await store.saveSsoVerifyReport(sampleReport({ ephemeralUser: 'first' }));
    await store.saveSsoVerifyReport(sampleReport({ ephemeralUser: 'second' }));
    const loaded = await store.loadSsoVerifyReport();
    expect(loaded!.report.ephemeralUser).toBe('second');
  });

  it('returns null on a corrupt file rather than throwing', async () => {
    await fs.writeFile(path.join(tmpDir, 'sso-verify-report.json'), '{ not json', 'utf-8');
    expect(await store.loadSsoVerifyReport()).toBeNull();
  });
});
