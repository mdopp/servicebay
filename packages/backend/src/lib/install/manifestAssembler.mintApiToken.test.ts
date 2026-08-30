/**
 * #2673 — the ServiceBay MCP token is minted at install, against the REAL
 * token store.
 *
 * The sibling `manifestAssembler.test.ts` covers this through mocks. This file
 * exists because the one acceptance criterion that mocks cannot settle is
 * *"a re-install does not accumulate orphaned tokens"*: that only holds if the
 * minted plaintext lands in the same saved-secrets store every other generated
 * secret uses, so the next run resolves it instead of minting again. A mocked
 * store proves the assembler's intent, not the wiring — so here the real
 * `createToken`, the real `installedSecrets` config store and the real
 * `templates/claude-dev/variables.json` run against a temp DATA_DIR, and the
 * tokens on disk are COUNTED before and after.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobInputVariable } from './jobStore';

// Set before the module graph is imported — DATA_DIR is read at load time in
// `lib/dirs.ts`, and both the token store and config.json hang off it.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mint-token-'));
process.env.DATA_DIR = DATA_DIR;

type StoredToken = { name: string; scopes: string[]; expiresAt?: string; createdBy: string };

/** Every token currently on disk. Absent file = no tokens ever minted. */
function storedTokens(): StoredToken[] {
  const f = path.join(DATA_DIR, 'api-tokens.json');
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf-8')).tokens as StoredToken[];
}

let assembleManifest: typeof import('./manifestAssembler').assembleManifest;
let verifyToken: typeof import('@/lib/auth/apiTokens').verifyToken;

const install = (prefilled?: Record<string, string>) =>
  assembleManifest({
    items: [{ name: 'claude-dev', checked: true }],
    templateSource: 'Built-in',
    ...(prefilled ? { prefilled } : {}),
  });

const mcpToken = (vars: JobInputVariable[]) =>
  vars.find(v => v.name === 'SERVICEBAY_MCP_TOKEN')?.value ?? '';

beforeAll(async () => {
  fs.writeFileSync(
    path.join(DATA_DIR, 'config.json'),
    JSON.stringify({ reverseProxy: { publicDomain: 'example.com' } }),
  );
  ({ assembleManifest } = await import('./manifestAssembler'));
  ({ verifyToken } = await import('@/lib/auth/apiTokens'));
});

describe('claude-dev SERVICEBAY_MCP_TOKEN — real mint, real store (#2673)', () => {
  it('installs with no operator step, read-only + non-expiring, and re-installs mint nothing', async () => {
    expect(storedTokens()).toHaveLength(0);

    // Acceptance 1 — the field is left blank; a usable token comes out.
    const first = mcpToken((await install()).variables);
    expect(first).toMatch(/^sb_[0-9a-f]{8}_[A-Z2-9]{32}$/);
    // …and it survives the entrypoint's charset guard, which refuses to
    // configure the MCP server for a value outside [A-Za-z0-9_-].
    expect(first).not.toMatch(/[^A-Za-z0-9_-]/);

    // Acceptance 2 — read scope only, no expiry. Asserted against the token
    // that was actually written, not against the arguments passed in.
    expect(storedTokens()).toHaveLength(1);
    expect(storedTokens()[0].scopes).toEqual(['read']);
    expect(storedTokens()[0].expiresAt).toBeUndefined();
    expect(storedTokens()[0].name).toContain('claude-dev');
    const verified = await verifyToken(first);
    expect(verified?.scopes).toEqual(['read']);

    // Acceptance 4 — COUNTED, not asserted. A second install that re-minted
    // would leave two rows here and orphan the first.
    const second = mcpToken((await install()).variables);
    expect(storedTokens()).toHaveLength(1);
    expect(second).toBe(first);

    // Acceptance 3 — an operator-pasted value wins, and still mints nothing.
    const third = await install({ SERVICEBAY_MCP_TOKEN: 'sb_operator_supplied' });
    expect(mcpToken(third.variables)).toBe('sb_operator_supplied');
    expect(storedTokens()).toHaveLength(1);
  });
});
