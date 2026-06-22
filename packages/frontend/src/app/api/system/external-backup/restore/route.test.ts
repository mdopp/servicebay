import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Scope-guard lock-in for the per-capability audit (#2050, docs/SCOPE_AUDIT.md).
 *
 * The destructive REST routes have no central scope map (unlike MCP TOOL_SCOPES) —
 * each declares its guard inline via `withApiHandler({ tokenScope })`. This test
 * pins the intended scope for the security-sensitive destructive routes so a
 * regression (e.g. loosening restore back to `lifecycle`) fails CI.
 *
 * Source-level assertion rather than a request round-trip: the guard is the literal
 * `tokenScope` baked into the route's `withApiHandler` options, and these routes
 * pull in heavy host/NAS deps that a unit test should not load to read one string.
 */
const ROUTES_DIR = path.resolve(__dirname, '../../../..');

function tokenScopeOf(relPath: string): string | null {
  const src = readFileSync(path.join(ROUTES_DIR, relPath), 'utf8');
  // Match the POST/DELETE handler's tokenScope; these single-mutating-verb
  // routes declare exactly one.
  const m = src.match(/tokenScope:\s*'([a-z]+)'/);
  return m ? m[1] : null;
}

describe('destructive REST route scope guards (#2050 audit lock-in)', () => {
  it('external-backup/restore POST is gated at destroy (corrected from lifecycle)', () => {
    // Restoring into a live service data dir with force clobbers data —
    // an irreversible state edit, the destroy tier. Matches the config-restore
    // route and the MCP restore_backup tool.
    expect(tokenScopeOf('api/system/external-backup/restore/route.ts')).toBe('destroy');
  });

  it('settings/backups/restore POST is gated at destroy', () => {
    expect(tokenScopeOf('api/settings/backups/restore/route.ts')).toBe('destroy');
  });

  it('stacks wipe DELETE is gated at destroy', () => {
    expect(tokenScopeOf('api/system/stacks/[name]/wipe/route.ts')).toBe('destroy');
  });
});
