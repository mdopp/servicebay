import { describe, it, expect } from 'vitest';
import {
  selectMigrationChain,
  checkMinUpgradableSchemaVersion,
  MIGRATION_REFUSAL_PREFIX,
} from './migrations';
import type { TemplateMigrationScript } from '@/lib/registry';

function mig(fromVersion: number, toVersion: number, content = ''): TemplateMigrationScript {
  return { filename: `v${fromVersion}-to-v${toVersion}.py`, fromVersion, toVersion, content };
}

describe('selectMigrationChain', () => {
  it('returns an empty chain when no prior install (fresh)', () => {
    const result = selectMigrationChain(null, 3, [mig(1, 2), mig(2, 3)]);
    expect(result).toEqual({ ok: true, chain: [] });
  });

  it('returns an empty chain when installed >= target', () => {
    expect(selectMigrationChain(3, 3, [mig(1, 2)])).toEqual({ ok: true, chain: [] });
    expect(selectMigrationChain(5, 3, [mig(1, 2)])).toEqual({ ok: true, chain: [] });
  });

  it('walks contiguous one-step hops in order', () => {
    const scripts = [mig(2, 3), mig(1, 2), mig(3, 4)]; // intentionally out-of-order input
    const result = selectMigrationChain(1, 4, scripts);
    if (!result.ok) throw new Error('expected ok');
    expect(result.chain.map(s => s.filename)).toEqual([
      'v1-to-v2.py',
      'v2-to-v3.py',
      'v3-to-v4.py',
    ]);
  });

  it('reports missing-step when a hop is absent', () => {
    const result = selectMigrationChain(1, 3, [mig(1, 2)]); // missing v2→v3
    expect(result).toEqual({
      ok: false,
      reason: 'missing-step',
      from: 2,
      expectedNext: 3,
      available: [1],
    });
  });

  it('reports missing-step when the very first hop is absent', () => {
    const result = selectMigrationChain(1, 3, [mig(2, 3)]); // missing v1→v2
    expect(result).toEqual({
      ok: false,
      reason: 'missing-step',
      from: 1,
      expectedNext: 2,
      available: [2],
    });
  });

  it('rejects skip-version files (v1→v3 with no v2 stop) as overlapping', () => {
    const result = selectMigrationChain(1, 3, [mig(1, 3)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('overlapping-steps');
    if (result.reason !== 'overlapping-steps') return;
    expect(result.conflicts).toContainEqual({ fromVersion: 1, toVersion: 3 });
  });

  it('rejects two scripts upgrading from the same version as overlapping', () => {
    const result = selectMigrationChain(1, 3, [mig(1, 2), mig(1, 2)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('overlapping-steps');
  });

  it('returns a single-step chain when installed=current-1', () => {
    const scripts = [mig(1, 2), mig(2, 3), mig(3, 4)];
    const result = selectMigrationChain(3, 4, scripts);
    if (!result.ok) throw new Error('expected ok');
    expect(result.chain.map(s => s.filename)).toEqual(['v3-to-v4.py']);
  });

  it('ignores scripts beyond the target version', () => {
    const scripts = [mig(1, 2), mig(2, 3), mig(3, 4), mig(4, 5)];
    const result = selectMigrationChain(1, 3, scripts);
    if (!result.ok) throw new Error('expected ok');
    expect(result.chain.map(s => s.filename)).toEqual(['v1-to-v2.py', 'v2-to-v3.py']);
  });
});

// ─── #2727 — a box below the floor is told so, not left to `missing-step` ───
//
// The Zusage this encodes: a box below the declared minimum gets a clear,
// actionable error AT the upgrade, naming the template, the version it is
// recorded at, and the minimum — never a silent no-chain, and never a message
// about an internal script filename it cannot act on.
describe('checkMinUpgradableSchemaVersion', () => {
  it('refuses a box recorded below the floor', () => {
    const msg = checkMinUpgradableSchemaVersion('media', 2, 3, 8);
    expect(msg).not.toBeNull();
    // The three facts the operator needs to act, all present.
    expect(msg).toContain('media');
    expect(msg).toContain('v2');
    expect(msg).toContain('v3');
    expect(msg).toContain('v8');
    expect(msg).toContain('servicebay.min-upgradable-schema-version');
  });

  it('names a concrete next step, not just the refusal', () => {
    const msg = checkMinUpgradableSchemaVersion('home-assistant', 4, 6, 8)!;
    expect(msg).toContain('templates/home-assistant/CHANGELOG.md');
    expect(msg).toMatch(/migrate the\s+data by hand, or re-install/);
  });

  it('starts with the prefix install/runner.ts re-throws on', () => {
    // The runner wraps chain discovery in a best-effort try/catch and only
    // re-throws errors carrying this prefix. A refusal without it would be
    // downgraded to "continuing without migrations" — the exact silent no-op
    // the floor exists to replace.
    expect(checkMinUpgradableSchemaVersion('media', 1, 3, 8))
      .toMatch(new RegExp(`^${MIGRATION_REFUSAL_PREFIX}`));
  });

  it('lets a box at or above the floor through', () => {
    expect(checkMinUpgradableSchemaVersion('media', 3, 3, 8)).toBeNull();
    expect(checkMinUpgradableSchemaVersion('media', 7, 3, 8)).toBeNull();
  });

  it('does not apply to a fresh install', () => {
    // No prior install → the deploy stamps the current version without
    // running a hop, so the floor is irrelevant.
    expect(checkMinUpgradableSchemaVersion('media', null, 3, 8)).toBeNull();
  });

  it('is a no-op for the default floor of 1', () => {
    expect(checkMinUpgradableSchemaVersion('beets', 1, 1, 3)).toBeNull();
  });
});
