import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * #2399 — a transient config-read failure must never be indistinguishable
 * from "this box has literally never been configured".
 *
 * `getConfig()` used to swallow every read error and return `DEFAULT_CONFIG`
 * (no gateway, no `setupCompleted`), which `checkOnboardingStatus()` reads as
 * `needsSetup: true` — so one EIO/ESTALE/permission blip on the data volume
 * force-opened the onboarding wizard on a fully configured box.
 *
 * The failure isn't reproducible on a live box, so it is fault-injected here:
 * a real, fully populated `config.json` sits in a temp DATA_DIR while
 * `fs.readFile` is made to fail for the first N calls.
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

/** Exactly the expression `checkOnboardingStatus()` derives needsSetup from. */
const derivesNeedsSetup = (config: { setupCompleted?: boolean; gateway?: unknown }): boolean =>
  !config.setupCompleted && !config.gateway;

const POPULATED_CONFIG = {
  serverName: 'already-configured-box',
  setupCompleted: true,
  gateway: { type: 'fritzbox', host: '192.168.178.1', username: 'admin' },
  publicDomain: 'example.com',
  autoUpdate: { enabled: true, schedule: '0 0 * * *', channel: 'stable' },
};

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected fault`), { code });

/** Fresh module graph so CONFIG_PATH is recomputed against the temp DATA_DIR. */
async function loadConfigModule() {
  vi.resetModules();
  return import('@/lib/config');
}

/**
 * Make `fs.readFile` fail for the first `failures.length` calls, then fall
 * through to the real implementation. Only the config path is faulted so the
 * rest of the module graph keeps working.
 */
function injectReadFailures(failures: NodeJS.ErrnoException[]) {
  const configPath = path.join(dataDir, 'config.json');
  const real = fs.readFile.bind(fs);
  let seen = 0;
  return vi.spyOn(fs, 'readFile').mockImplementation((async (file: Parameters<typeof fs.readFile>[0], options?: unknown) => {
    if (String(file) === configPath && seen < failures.length) {
      throw failures[seen++];
    }
    return real(file as string, options as Parameters<typeof fs.readFile>[1]);
  }) as typeof fs.readFile);
}

describe('getConfig() config-read resilience (#2399)', () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-config-read-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const writePopulatedConfig = () =>
    fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(POPULATED_CONFIG, null, 2));

  it('a transient non-ENOENT read failure does not report a configured box as unconfigured', async () => {
    await writePopulatedConfig();
    const spy = injectReadFailures([errno('EIO')]);

    const { getConfig } = await loadConfigModule();
    const config = await getConfig();

    expect(spy.mock.calls.length).toBeGreaterThan(1); // it retried
    expect(config.setupCompleted).toBe(true);
    expect(config.gateway?.host).toBe('192.168.178.1');
    expect(derivesNeedsSetup(config)).toBe(false);
  });

  it('a transient ENOENT on a file that is really there is retried, not believed', async () => {
    await writePopulatedConfig();
    injectReadFailures([errno('ENOENT'), errno('ENOENT')]);

    const { getConfig } = await loadConfigModule();
    const config = await getConfig();

    expect(config.setupCompleted).toBe(true);
    expect(derivesNeedsSetup(config)).toBe(false);
  });

  it('recovers from an ESTALE blip and still returns the persisted gateway', async () => {
    await writePopulatedConfig();
    injectReadFailures([errno('ESTALE')]);

    const { getConfig } = await loadConfigModule();
    expect(derivesNeedsSetup(await getConfig())).toBe(false);
  });

  it('a genuinely fresh install (file truly absent) still returns defaults and triggers onboarding', async () => {
    // No config.json written at all — the legitimate first-boot case.
    const { getConfig } = await loadConfigModule();
    const config = await getConfig();

    expect(config.setupCompleted).toBeUndefined();
    expect(config.gateway).toBeUndefined();
    expect(derivesNeedsSetup(config)).toBe(true);
  });

  it('a persistent read failure surfaces as ConfigReadError instead of silent defaults', async () => {
    await writePopulatedConfig();
    injectReadFailures([errno('EACCES'), errno('EACCES'), errno('EACCES')]);

    const { getConfig, ConfigReadError } = await loadConfigModule();
    await expect(getConfig()).rejects.toBeInstanceOf(ConfigReadError);
  });

  it('a corrupt-but-present config file surfaces an error rather than reading as never-configured', async () => {
    await fs.writeFile(path.join(dataDir, 'config.json'), '{ this is not json');

    const { getConfig, ConfigReadError } = await loadConfigModule();
    await expect(getConfig()).rejects.toBeInstanceOf(ConfigReadError);
  });

  it('confirmed absence is decided by stat, not by readFile alone', async () => {
    // The file is absent and stat agrees → defaults, and no retry storm.
    const statSpy = vi.spyOn(fs, 'stat');
    const { getConfig } = await loadConfigModule();
    await getConfig();
    expect(statSpy).toHaveBeenCalledWith(path.join(dataDir, 'config.json'));
    expect(fsSync.existsSync(path.join(dataDir, 'config.json'))).toBe(false);
  });
});
