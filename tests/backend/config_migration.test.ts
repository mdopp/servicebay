// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * #2725 — `migrateConfig` after the schema-version ledger was deleted.
 *
 * The ledger (`CURRENT_SCHEMA_VERSION`, `getSchemaVersion`, the
 * `schemaVersion` stamp, `config/transformer.ts`) never did anything: the
 * version was `1` for its whole life and nothing branched on it. What the
 * boot-time migration *does* do is real and still has live boxes behind it —
 * 5.12.x (2026-08-13) shipped `externalLinks[].ip_targets` and the
 * Vaultwarden `credentialVault`. These are the Rot-Proben for that: a config
 * written by 5.12.x must load, and one boot must physically clean it.
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

// Identity crypto: this file is about which keys survive a migrate, not about
// key derivation, and the real KDF would dominate the runtime.
vi.mock('@/lib/secrets', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

/** A config.json as 5.12.x persisted it, ledger stamp and dead vault included. */
const CONFIG_5_12 = {
  schemaVersion: 1,
  serverName: 'legacy-box',
  setupCompleted: true,
  credentialVault: {
    enabled: true,
    technicalAccountEmail: 'servicebay@example.invalid',
    technicalAccountPassword: 'PLACEHOLDER-NOT-A-REAL-SECRET',
  },
  externalLinks: [
    { id: 'legacy', name: 'Legacy', url: 'https://example.com', ip_targets: ['10.0.0.1:80'] },
  ],
};

const configPath = () => path.join(dataDir, 'config.json');
const readPersisted = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(configPath(), 'utf-8'));

/** Fresh module graph per test: `config.ts` freezes CONFIG_PATH at import. */
async function loadConfigModule() {
  vi.resetModules();
  return import('@/lib/config');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-config-migration-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('migrateConfig on a 5.12.x config (#2725)', () => {
  it('loads a 5.12.x config without error and keeps the operator data', async () => {
    await fs.writeFile(configPath(), JSON.stringify(CONFIG_5_12, null, 2));
    const { getConfig } = await loadConfigModule();

    const config = await getConfig();

    expect(config.serverName).toBe('legacy-box');
    expect(config.setupCompleted).toBe(true);
  });

  it('renames externalLinks[].ip_targets to ipTargets and drops the legacy key', async () => {
    await fs.writeFile(configPath(), JSON.stringify(CONFIG_5_12, null, 2));
    const { migrateConfig } = await loadConfigModule();

    await migrateConfig();

    const persisted = await readPersisted();
    const [link] = persisted.externalLinks as Array<Record<string, unknown>>;
    expect(link.ipTargets).toEqual(['10.0.0.1:80']);
    expect(link).not.toHaveProperty('ip_targets');
  });

  it('keeps a newer ipTargets value when a half-migrated entry carries both', async () => {
    await fs.writeFile(configPath(), JSON.stringify({
      externalLinks: [{
        id: 'both', name: 'Both', url: 'https://example.com',
        ip_targets: ['10.0.0.1:80'], ipTargets: ['10.0.0.2:443'],
      }],
    }, null, 2));
    const { migrateConfig } = await loadConfigModule();

    await migrateConfig();

    const persisted = await readPersisted();
    const [link] = persisted.externalLinks as Array<Record<string, unknown>>;
    expect(link.ipTargets).toEqual(['10.0.0.2:443']);
    expect(link).not.toHaveProperty('ip_targets');
  });

  it('removes the dead credentialVault so the password stops sitting in config.json', async () => {
    await fs.writeFile(configPath(), JSON.stringify(CONFIG_5_12, null, 2));
    const { migrateConfig } = await loadConfigModule();

    await migrateConfig();

    expect(await readPersisted()).not.toHaveProperty('credentialVault');
  });

  it('no longer stamps schemaVersion — the field is unstamped, not carried forward', async () => {
    await fs.writeFile(configPath(), JSON.stringify(CONFIG_5_12, null, 2));
    const { migrateConfig } = await loadConfigModule();

    await migrateConfig();

    expect(await readPersisted()).not.toHaveProperty('schemaVersion');
  });

  it('is idempotent: a second run leaves the migrated document unchanged', async () => {
    await fs.writeFile(configPath(), JSON.stringify(CONFIG_5_12, null, 2));
    const { migrateConfig } = await loadConfigModule();

    await migrateConfig();
    const afterFirst = await readPersisted();
    await migrateConfig();

    expect(await readPersisted()).toEqual(afterFirst);
  });
});
