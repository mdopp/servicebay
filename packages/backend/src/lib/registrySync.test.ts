/**
 * #2610 — syncRegistries reports what happened, and backs off from the hopeless
 * (a cooldown, not a latch — #2809).
 *
 * The reference box has two registries: one that clones and one it has no
 * credentials for. Before this fix the second was re-cloned on every server
 * boot and every install — failing identically each time, one WARN per cycle —
 * while every caller was told "refreshed".
 *
 * These run REAL git against local repositories (one that exists, one that
 * does not), because the behaviour under test is "what happens across repeated
 * runs", and a stubbed child_process would let a broken give-up rule pass.
 * Only the persisted counter is held in memory, so the suite never writes to
 * a shared DATA_DIR.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import nodePath from 'node:path';

// Must be set before registry.ts is imported: REGISTRIES_DIR is a module const,
// read at import time — so this runs in a hoisted block, not in beforeAll.
const dirs = vi.hoisted(() => {
  const root = `/tmp/sb-registry-sync-${process.pid}`;
  process.env.CONTAINER_CONFIG_DIR = `${root}/config`;
  return { root, good: `${root}/good.git`, missing: `${root}/gone.git` };
});

const GOOD_URL = `file://${dirs.good}`;
const MISSING_URL = `file://${dirs.missing}`;

vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  getConfig: vi.fn().mockResolvedValue({
    registries: [
      { name: 'servicebay', url: `file://${dirs.good}` },
      { name: 'ServiceBay Templates', url: `file://${dirs.missing}` },
    ],
  }),
}));

// Keep the real classification/formatting; hold the persisted counter in memory.
const persisted = vi.hoisted(() => ({ state: {} as Record<string, { consecutiveFailures: number; name: string; lastAttemptAt?: string }> }));
vi.mock('./registrySyncState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registrySyncState')>();
  return {
    ...actual,
    loadRegistrySyncState: vi.fn(async () => persisted.state),
    saveRegistrySyncState: vi.fn(async (s: Record<string, { consecutiveFailures: number; name: string; lastAttemptAt?: string }>) => {
      persisted.state = s;
    }),
  };
});

import { syncRegistries } from './registry';
import { REGISTRY_GIVE_UP_AFTER, registryStateKey } from './registrySyncState';

const failureRecord = () => persisted.state[registryStateKey('ServiceBay Templates', MISSING_URL)];

beforeAll(() => {
  fsSync.rmSync(dirs.root, { recursive: true, force: true });
  // A real, clonable registry: one commit carrying a templates/ directory.
  const work = nodePath.join(dirs.root, 'work');
  fsSync.mkdirSync(nodePath.join(work, 'templates', 'demo'), { recursive: true });
  fsSync.writeFileSync(nodePath.join(work, 'templates', 'demo', 'template.yml'), 'name: demo\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  execFileSync('git', ['clone', '-q', '--bare', work, dirs.good], { stdio: 'ignore' });
  // dirs.missing is deliberately never created.
});

beforeEach(() => {
  persisted.state = {};
  fsSync.rmSync(process.env.CONTAINER_CONFIG_DIR as string, { recursive: true, force: true });
});

describe('syncRegistries reports per registry (#2610)', () => {
  it('returns the denominator alongside what actually synced', async () => {
    const summary = await syncRegistries();

    expect(summary.requested).toBe(2);
    expect(summary.synced).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results.find(r => r.name === 'servicebay')?.status).toBe('synced');

    const failed = summary.results.find(r => r.name === 'ServiceBay Templates');
    expect(failed?.status).toBe('failed');
    expect(failed?.reason).toBeTruthy();
    expect(failed?.advice).toBeTruthy();
    expect(failed?.consecutiveFailures).toBe(1);
    // No caller can read this as "everything refreshed".
    expect(summary.synced).toBeLessThan(summary.requested);
  });

  it('counts consecutive failures, and keeps the healthy registry at zero', async () => {
    await syncRegistries();
    await syncRegistries();

    expect(failureRecord().consecutiveFailures).toBe(2);
    expect(persisted.state[registryStateKey('servicebay', GOOD_URL)].consecutiveFailures).toBe(0);
  });

  it('stops retrying after REGISTRY_GIVE_UP_AFTER attempts instead of looping forever', async () => {
    for (let i = 0; i < REGISTRY_GIVE_UP_AFTER; i++) await syncRegistries();
    expect(failureRecord().consecutiveFailures).toBe(REGISTRY_GIVE_UP_AFTER);

    const summary = await syncRegistries();

    // No further attempt was made — the counter did not move…
    expect(failureRecord().consecutiveFailures).toBe(REGISTRY_GIVE_UP_AFTER);
    // …and the registry is still counted and still explained, never silent.
    const skipped = summary.results.find(r => r.name === 'ServiceBay Templates');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.reason).toBeTruthy();
    expect(skipped?.advice).toBeTruthy();
    expect(skipped?.consecutiveFailures).toBe(REGISTRY_GIVE_UP_AFTER);
    expect(summary).toMatchObject({ requested: 2, synced: 1, skipped: 1, failed: 0 });

    // The working registry keeps syncing regardless.
    expect(summary.results.find(r => r.name === 'servicebay')?.status).toBe('synced');
  });

  it('retries on its own once the cooldown has passed — no click required (#2809)', async () => {
    for (let i = 0; i < REGISTRY_GIVE_UP_AFTER; i++) await syncRegistries();
    expect((await syncRegistries()).skipped).toBe(1);

    // Same box, two days later: the boot sync finds the record stale…
    failureRecord().lastAttemptAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const summary = await syncRegistries();

    // …and tries again — counted as a failure, not silently skipped.
    expect(summary.results.find(r => r.name === 'ServiceBay Templates')?.status).toBe('failed');
    expect(failureRecord().consecutiveFailures).toBe(REGISTRY_GIVE_UP_AFTER + 1);
    // Inside the (now longer) cooldown it is skipped again.
    expect((await syncRegistries()).skipped).toBe(1);
  });

  it('retries anyway when the operator asks for it explicitly (force)', async () => {
    for (let i = 0; i < REGISTRY_GIVE_UP_AFTER; i++) await syncRegistries();

    const summary = await syncRegistries({ force: true });

    expect(failureRecord().consecutiveFailures).toBe(REGISTRY_GIVE_UP_AFTER + 1);
    expect(summary.results.find(r => r.name === 'ServiceBay Templates')?.status).toBe('failed');
  });

  it('a registry that starts working again clears its give-up state', async () => {
    for (let i = 0; i < REGISTRY_GIVE_UP_AFTER; i++) await syncRegistries();
    // Same shape as the operator fixing the cause: the URL now resolves.
    execFileSync('git', ['clone', '-q', '--bare', dirs.good, dirs.missing], { stdio: 'ignore' });

    const summary = await syncRegistries({ force: true });

    expect(summary.results.find(r => r.name === 'ServiceBay Templates')?.status).toBe('synced');
    expect(failureRecord().consecutiveFailures).toBe(0);
    // And the next automatic sync treats it as healthy again.
    const next = await syncRegistries();
    expect(next.synced).toBe(2);
    expect(next.skipped).toBe(0);
    fsSync.rmSync(dirs.missing, { recursive: true, force: true });
  });

  it('never puts a credential from a registry URL into the outcome', async () => {
    const summary = await syncRegistries();
    for (const r of summary.results) {
      expect(r.url).not.toMatch(/@/);
    }
  });
});
