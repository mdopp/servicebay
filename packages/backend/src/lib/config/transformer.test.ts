import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ConfigTransformer } from './transformer';

let workDir: string;
let configPath: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-config-transformer-'));
  configPath = path.join(workDir, 'config.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function writeConfig(data: unknown) {
  await fs.writeFile(configPath, JSON.stringify(data));
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(configPath, 'utf-8'));
}

describe('ConfigTransformer (#1099 schema-version-baseline)', () => {
  it('stamps schemaVersion: 1 on legacy configs missing the field', async () => {
    await writeConfig({ serverName: 'legacy-box' });
    const changed = await new ConfigTransformer(configPath).run();
    expect(changed).toBe(true);
    const after = await readConfig();
    expect(after.schemaVersion).toBe(1);
    expect(after.serverName).toBe('legacy-box');
  });

  it('leaves existing schemaVersion alone (no overwrite)', async () => {
    await writeConfig({ schemaVersion: 5, serverName: 'time-traveller' });
    const changed = await new ConfigTransformer(configPath).run();
    expect(changed).toBe(false);
    const after = await readConfig();
    expect(after.schemaVersion).toBe(5);
  });

  it('writes nothing back when the config is already at baseline (idempotent)', async () => {
    await writeConfig({ schemaVersion: 1, serverName: 'fresh-install' });
    const before = await fs.stat(configPath);
    const changed = await new ConfigTransformer(configPath).run();
    expect(changed).toBe(false);
    const after = await fs.stat(configPath);
    // Idempotency check: untouched mtime means no .bak backup either,
    // which is the contract for the no-op path.
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
