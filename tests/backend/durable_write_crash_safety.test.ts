// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * #2414 — a crash landing inside a durable-state write must leave the ORIGINAL
 * file intact, never a truncated one.
 *
 * `config.json` and `checks.json` under DATA_DIR are operator data, not caches:
 * a truncated `config.json` re-onboards the box (domain / auth / service config
 * gone), a truncated `checks.json` drops every configured health check. Both
 * used to be written with a bare `fs.writeFile` / `fs.writeFileSync`, which
 * truncates the target *before* the new bytes land — so a power cut, OOM-kill
 * or container stop mid-write destroyed the file permanently.
 *
 * The fault isn't reproducible on a live box, so it is injected here: a real,
 * fully populated file sits in a temp DATA_DIR while the write syscall is made
 * to land a partial prefix and then throw. Each `survives` case is paired with
 * a `control` case that performs the *pre-fix* truncate-then-partial-write
 * against the same file — the control must destroy it, otherwise the injection
 * would be vacuous and the survival assertion would prove nothing.
 */

let dataDir = '';

vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return {
    ...actual,
    get DATA_DIR() { return dataDir; },
    get SSH_DIR() { return path.join(dataDir, 'ssh'); },
  };
});

// Identity crypto: `saveConfig` encrypts sensitive fields on the way out, and
// the real KDF has nothing to do with the durability property under test.
vi.mock('@/lib/secrets', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

const eio = () => Object.assign(new Error('EIO: injected crash mid-write'), { code: 'EIO' });

/** Files vitest/atomicWrite may leave behind: `.config.json.<pid>.<hex>.tmp`. */
const strayTmpFiles = () => fsSync.readdirSync(dataDir).filter(f => f.endsWith('.tmp'));

/**
 * What a bare `fs.writeFile(path, data)` does when the process dies mid-call:
 * open with 'w' (which truncates immediately), write part of the payload, then
 * stop. No temp file, no rename — the original bytes are already gone.
 */
async function bareWriteInterrupted(target: string, data: string) {
  const handle = await fs.open(target, 'w');
  await handle.writeFile(data.slice(0, Math.floor(data.length / 2)));
  await handle.close();
}

// ---------------------------------------------------------------------------
// saveConfig — the boot-time config writer (async, atomicWriteFile). This is
// what `migrateConfig` calls once per boot now that `config/transformer.ts` is
// gone (#2725), so it is the write a crash can land in.
// ---------------------------------------------------------------------------
describe('saveConfig write survives a crash mid-write (#2414)', () => {
  let configPath = '';
  // A populated, legacy-shaped config — the file whose loss re-onboards the box.
  const ORIGINAL = {
    serverName: 'already-configured-box',
    setupCompleted: true,
    gateway: { type: 'fritzbox', host: '192.168.178.1', username: 'admin' },
    publicDomain: 'example.com',
    externalLinks: [
      { id: 'legacy', name: 'Legacy', url: 'https://example.com', ip_targets: ['10.0.0.1:80'] },
    ],
  };
  const ORIGINAL_TEXT = JSON.stringify(ORIGINAL, null, 2);

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-durable-config-'));
    configPath = path.join(dataDir, 'config.json');
    await fs.writeFile(configPath, ORIGINAL_TEXT);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  /**
   * Fault-inject the write itself, at BOTH entry points the module could use,
   * so the outcome is a property of the writer and not of the injection:
   *  - `fs.open` (the atomic path) — real open, but the returned handle's
   *    `writeFile` lands half the payload on the temp file and then throws;
   *  - `fs.writeFile` (the bare path) — truncating open, half the payload,
   *    then throw, i.e. exactly what a crash inside a bare write looks like.
   * Only the atomic writer can survive this; a bare writer loses the file.
   */
  function injectPartialWriteThenCrash() {
    const realOpen = fs.open.bind(fs);
    const halve = (data: unknown) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString();
      return text.slice(0, Math.floor(text.length / 2));
    };
    vi.spyOn(fs, 'writeFile').mockImplementation((async (target: unknown, data: unknown) => {
      const handle = await realOpen(String(target), 'w');
      await handle.writeFile(halve(data));
      await handle.close();
      throw eio();
    }) as typeof fs.writeFile);
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = (async (data: string | Uint8Array, opts?: unknown) => {
        await realWrite(halve(data), opts as Parameters<typeof handle.writeFile>[1]);
        throw eio();
      }) as typeof handle.writeFile;
      return handle;
    }) as typeof fs.open);
  }

  /** Fresh module graph per test: `config.ts` freezes CONFIG_PATH at import. */
  async function loadSaveConfig() {
    vi.resetModules();
    const { saveConfig } = await import('@/lib/config');
    const payload = { ...ORIGINAL, serverName: 'renamed-box' } as unknown as Parameters<typeof saveConfig>[0];
    return () => saveConfig(payload);
  }

  it('leaves config.json fully intact when the write dies half-written', async () => {
    const save = await loadSaveConfig();
    injectPartialWriteThenCrash();
    const outcome = await save().then(() => null, (e: Error) => e);

    // The load-bearing assertion: whatever the writer did, the operator's
    // config must still be on disk, whole and parseable.
    const after = fsSync.readFileSync(configPath, 'utf-8');
    expect(after).toBe(ORIGINAL_TEXT);
    expect(JSON.parse(after)).toEqual(ORIGINAL);
    expect(strayTmpFiles()).toEqual([]);
    expect(outcome?.message).toMatch(/injected crash/);
  });

  it('leaves config.json fully intact when the crash lands on the rename', async () => {
    const save = await loadSaveConfig();
    vi.spyOn(fs, 'rename').mockRejectedValue(eio());

    await expect(save()).rejects.toThrow(/injected crash/);

    expect(JSON.parse(await fs.readFile(configPath, 'utf-8'))).toEqual(ORIGINAL);
    expect(strayTmpFiles()).toEqual([]);
  });

  it('control: the pre-fix bare write truncates config.json under the same fault', async () => {
    await bareWriteInterrupted(configPath, JSON.stringify({ ...ORIGINAL, serverName: 'renamed-box' }, null, 2));

    const after = await fs.readFile(configPath, 'utf-8');
    expect(after).not.toBe(ORIGINAL_TEXT);
    expect(() => JSON.parse(after)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// HealthStore.writeChecks — the operator's configured checks (sync).
// ---------------------------------------------------------------------------
describe('HealthStore.writeChecks survives a crash mid-write (#2414)', () => {
  let checksFile = '';
  const FIRST = { id: 'check-1', name: 'Gateway', type: 'ping', target: '192.168.178.1', interval: 60 };
  const SECOND = { id: 'check-2', name: 'Portal', type: 'http', target: 'https://example.com', interval: 60 };

  async function loadStore() {
    vi.resetModules();
    return (await import('@/lib/health/store')).HealthStore;
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-durable-checks-'));
    checksFile = path.join(dataDir, 'checks.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  /** Land a partial payload on the (temp) fd, then throw. */
  function injectPartialWriteSyncThenCrash() {
    const real = fsSync.writeFileSync.bind(fsSync);
    return vi.spyOn(fsSync, 'writeFileSync').mockImplementation(((
      target: Parameters<typeof fsSync.writeFileSync>[0],
      data: Parameters<typeof fsSync.writeFileSync>[1],
      opts?: Parameters<typeof fsSync.writeFileSync>[2],
    ) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString();
      real(target, text.slice(0, Math.floor(text.length / 2)), opts);
      throw eio();
    }) as typeof fsSync.writeFileSync);
  }

  it('leaves checks.json fully intact when the write dies half-written', async () => {
    const HealthStore = await loadStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HealthStore.saveCheck(FIRST as any);
    const before = fsSync.readFileSync(checksFile, 'utf-8');
    expect(JSON.parse(before)).toHaveLength(1);

    injectPartialWriteSyncThenCrash();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => HealthStore.saveCheck(SECOND as any)).toThrow(/injected crash/);
    vi.restoreAllMocks();

    const after = fsSync.readFileSync(checksFile, 'utf-8');
    expect(after).toBe(before);
    expect(JSON.parse(after).map((c: { id: string }) => c.id)).toEqual(['check-1']);
    expect(strayTmpFiles()).toEqual([]);
  });

  it('control: the pre-fix bare write truncates checks.json under the same fault', async () => {
    const HealthStore = await loadStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    HealthStore.saveCheck(FIRST as any);
    const before = fsSync.readFileSync(checksFile, 'utf-8');

    await bareWriteInterrupted(checksFile, JSON.stringify([FIRST, SECOND], null, 2));

    const after = fsSync.readFileSync(checksFile, 'utf-8');
    expect(after).not.toBe(before);
    expect(() => JSON.parse(after)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A versioned store's write (#2739). `defineStore` wraps the payload in a
// `{ __store, version, data }` envelope before handing it to `atomicWriteFile`
// — the envelope must not weaken the #2414 guarantee, so the same fault is
// injected against an adopted store (NetworkStore, async).
// ---------------------------------------------------------------------------
describe('a versioned store write survives a crash mid-write (#2739 keeps #2414)', () => {
  let edgesFile = '';
  const mkEdge = (id: string) => ({
    id, source: `s-${id}`, target: `t-${id}`, created_at: new Date().toISOString(),
  });

  async function loadStore() {
    vi.resetModules();
    return (await import('@/lib/network/store')).NetworkStore;
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-durable-edges-'));
    edgesFile = path.join(dataDir, 'network-edges.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('leaves network-edges.json fully intact when the write dies half-written', async () => {
    const NetworkStore = await loadStore();
    await NetworkStore.addEdge(mkEdge('first'));
    const before = fsSync.readFileSync(edgesFile, 'utf-8');
    expect(JSON.parse(before).version).toBe(1);

    // Land half the payload on the temp fd, then throw — the crash window a
    // bare write would have opened on the target itself.
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = (async (data: string | Uint8Array, opts?: unknown) => {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString();
        await realWrite(text.slice(0, Math.floor(text.length / 2)), opts as Parameters<typeof handle.writeFile>[1]);
        throw eio();
      }) as typeof handle.writeFile;
      return handle;
    }) as typeof fs.open);

    await expect(NetworkStore.addEdge(mkEdge('second'))).rejects.toThrow(/injected crash/);
    vi.restoreAllMocks();

    const after = fsSync.readFileSync(edgesFile, 'utf-8');
    expect(after).toBe(before);
    expect(JSON.parse(after).data.map((e: { id: string }) => e.id)).toEqual(['first']);
    expect(strayTmpFiles()).toEqual([]);
    // And the store still reads it back, envelope and all.
    expect((await NetworkStore.getEdges()).map(e => e.id)).toEqual(['first']);
  });

  it('control: the pre-fix bare write truncates network-edges.json under the same fault', async () => {
    const NetworkStore = await loadStore();
    await NetworkStore.addEdge(mkEdge('first'));
    const before = fsSync.readFileSync(edgesFile, 'utf-8');

    await bareWriteInterrupted(edgesFile, JSON.stringify({ __store: 'network-edges', version: 1, data: [mkEdge('first'), mkEdge('second')] }, null, 2));

    const after = fsSync.readFileSync(edgesFile, 'utf-8');
    expect(after).not.toBe(before);
    expect(() => JSON.parse(after)).toThrow();
  });
});
