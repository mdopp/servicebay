import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #1264 — the token store moved from mcp-tokens.json to api-tokens.json.
// Point DATA_DIR at a fresh temp dir per test and exercise the real fs so
// the one-time legacy migration in loadFile is proven end-to-end.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

const tok = (id: string, name: string) => ({
  id, name, scopes: ['read'], hash: 'deadbeef', prefix: 'sb_a',
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'admin',
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-apitokens-'));
});
afterEach(async () => {
  // Drain verifyToken's fire-and-forget lastUsedAt write so it can't land in the
  // next test's dataDir (DATA_DIR is a live getter) or race the rm (ENOTEMPTY).
  await (await load()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const legacyPath = () => path.join(dataDir, 'mcp-tokens.json');
const newPath = () => path.join(dataDir, 'api-tokens.json');
const load = () => import('@/lib/auth/apiTokens');

describe('apiTokens storage migration (#1264)', () => {
  it('adopts a legacy mcp-tokens.json on first read and removes it', async () => {
    await fsp.writeFile(legacyPath(), JSON.stringify({ tokens: [tok('aaaaaaaa', 'old')] }));
    const { listTokens } = await load();

    expect((await listTokens()).map(t => t.id)).toEqual(['aaaaaaaa']);
    await expect(fsp.access(newPath())).resolves.toBeUndefined();      // new file written
    await expect(fsp.access(legacyPath())).rejects.toThrow();          // legacy removed
  });

  it('prefers an existing api-tokens.json and leaves the legacy file untouched', async () => {
    await fsp.writeFile(newPath(), JSON.stringify({ tokens: [tok('bbbbbbbb', 'new')] }));
    await fsp.writeFile(legacyPath(), JSON.stringify({ tokens: [tok('aaaaaaaa', 'old')] }));
    const { listTokens } = await load();

    expect((await listTokens()).map(t => t.id)).toEqual(['bbbbbbbb']);
    await expect(fsp.access(legacyPath())).resolves.toBeUndefined();   // not adopted, not deleted
  });

  it('returns empty when neither file exists', async () => {
    const { listTokens } = await load();
    expect(await listTokens()).toEqual([]);
  });

  it('migrated tokens still verify on the new path', async () => {
    // Mint via the real createToken (writes api-tokens.json), then prove a
    // fresh module load reads it back and verifies the secret.
    const { createToken, verifyToken } = await load();
    const { secret } = await createToken({ name: 'tui', scopes: ['read', 'mutate'], createdBy: 'admin' });

    vi.resetModules();
    const { verifyToken: verifyFresh } = await load();
    const verified = await verifyFresh(secret);
    expect(verified?.scopes).toEqual(['read', 'mutate']);
    void verifyToken;
  });
});
