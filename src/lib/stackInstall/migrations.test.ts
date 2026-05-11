import { describe, it, expect } from 'vitest';
import { selectMigrationChain } from './migrations';
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
