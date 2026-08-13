/**
 * #2531 — operator-set NON-secret variables must survive a reinstall.
 *
 * The store's rules are the whole fix: remember only what the operator
 * actually set (so a template can still bump a default), forget it when they
 * unset it (so a dropped value never comes back), and never duplicate a
 * secret in plaintext.
 */
import { describe, it, expect, vi } from 'vitest';

const updateConfig = vi.fn<(patch: unknown) => Promise<void>>(async () => undefined);
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({})),
  updateConfig: (patch: unknown) => updateConfig(patch),
}));

import {
  loadSavedVariables,
  isOperatorSetVariable,
  computeInstalledVariables,
  persistInstalledVariables,
  findUnrecoveredVariables,
  buildUnrecoveredVariablesWarning,
} from './savedVariables';
import type { AppConfig } from '@/lib/config';

const cfg = (installedVariables?: Array<{ varName: string; value: string }>): AppConfig =>
  ({ installedVariables }) as AppConfig;

describe('loadSavedVariables', () => {
  it('flattens the stored list', () => {
    expect(loadSavedVariables(cfg([{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }])))
      .toEqual({ VAPID_PUBLIC_KEY: 'BKx' });
  });

  it('is empty for a config that has never stored any', () => {
    expect(loadSavedVariables(cfg())).toEqual({});
  });
});

describe('isOperatorSetVariable', () => {
  it('counts a typed value whose template default is empty — the reported case', () => {
    // VAPID_PUBLIC_KEY: type text, variables.json default "".
    expect(isOperatorSetVariable({
      name: 'VAPID_PUBLIC_KEY', value: 'BKxRealKey', meta: { type: 'text', default: '' },
    })).toBe(true);
  });

  it('counts a value that overrides a non-empty default', () => {
    expect(isOperatorSetVariable({ name: 'PORT', value: '9000', meta: { type: 'text', default: '8080' } })).toBe(true);
  });

  it('does NOT count a value that is merely the template default', () => {
    // This is what keeps a template default bump reaching the box (#1297).
    expect(isOperatorSetVariable({ name: 'PORT', value: '8080', meta: { type: 'text', default: '8080' } })).toBe(false);
  });

  it('does NOT count an empty value', () => {
    expect(isOperatorSetVariable({ name: 'X', value: '', meta: { type: 'text', default: '' } })).toBe(false);
  });

  it('does NOT count a secret-typed variable — savedSecrets owns those', () => {
    for (const type of ['secret', 'bcrypt', 'rsa-private']) {
      expect(isOperatorSetVariable({ name: 'VAPID_PRIVATE_KEY', value: 'pem', meta: { type } })).toBe(false);
    }
  });

  it('does NOT count a global — those re-derive from config each run', () => {
    expect(isOperatorSetVariable({
      name: 'PUBLIC_DOMAIN', value: 'example.com', global: true, meta: { type: 'text' },
    })).toBe(false);
  });

  it('treats a metadata-less variable as operator-set (errs toward preserving)', () => {
    expect(isOperatorSetVariable({ name: 'X', value: 'typed' })).toBe(true);
  });
});

describe('computeInstalledVariables', () => {
  it('upserts an operator-set value', () => {
    const out = computeInstalledVariables(
      [{ name: 'VAPID_PUBLIC_KEY', value: 'BKx', meta: { type: 'text', default: '' } }],
      cfg(),
    );
    expect(out).toEqual([{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }]);
  });

  it('removes the record when the operator clears the value', () => {
    const out = computeInstalledVariables(
      [{ name: 'VAPID_PUBLIC_KEY', value: '', meta: { type: 'text', default: '' } }],
      cfg([{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }]),
    );
    expect(out).toEqual([]);
  });

  it('removes the record when the operator edits back to the default', () => {
    const out = computeInstalledVariables(
      [{ name: 'PORT', value: '8080', meta: { type: 'text', default: '8080' } }],
      cfg([{ varName: 'PORT', value: '9000' }]),
    );
    expect(out).toEqual([]);
  });

  it('leaves variables from other templates untouched', () => {
    const out = computeInstalledVariables(
      [{ name: 'IMMICH_X', value: 'v', meta: { type: 'text', default: '' } }],
      cfg([{ varName: 'AUTH_Y', value: 'kept' }]),
    );
    expect(out).toEqual([
      { varName: 'AUTH_Y', value: 'kept' },
      { varName: 'IMMICH_X', value: 'v' },
    ]);
  });

  it('never writes a secret value into the plaintext store', () => {
    const out = computeInstalledVariables(
      [{ name: 'VAPID_PRIVATE_KEY', value: 'pem-body', meta: { type: 'secret' } }],
      cfg(),
    );
    expect(out).toEqual([]);
  });
});

describe('persistInstalledVariables', () => {
  it('writes the computed list under installedVariables', async () => {
    updateConfig.mockClear();
    await persistInstalledVariables(
      [{ name: 'VAPID_PUBLIC_KEY', value: 'BKx', meta: { type: 'text', default: '' } }],
      cfg(),
    );
    expect(updateConfig).toHaveBeenCalledWith({
      installedVariables: [{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }],
    });
  });
});

describe('findUnrecoveredVariables — the loud condition', () => {
  it('names a variable that had a saved value and is deploying empty', () => {
    expect(findUnrecoveredVariables(
      [{ name: 'VAPID_PUBLIC_KEY', value: '' }],
      { VAPID_PUBLIC_KEY: 'BKx' },
    )).toEqual(['VAPID_PUBLIC_KEY']);
  });

  it('stays silent for a variable that was always empty (VAPID_SUBJECT by design)', () => {
    expect(findUnrecoveredVariables([{ name: 'VAPID_SUBJECT', value: '' }], {})).toEqual([]);
  });

  it('stays silent once the value is recovered', () => {
    expect(findUnrecoveredVariables(
      [{ name: 'VAPID_PUBLIC_KEY', value: 'BKx' }],
      { VAPID_PUBLIC_KEY: 'BKx' },
    )).toEqual([]);
  });

  it('says the value is lost, not merely unset, and offers no substitution', () => {
    const msg = buildUnrecoveredVariablesWarning(['VAPID_PUBLIC_KEY']);
    expect(msg).toContain('VAPID_PUBLIC_KEY');
    expect(msg).toContain('could not be recovered');
    expect(msg).toContain('EMPTY');
    expect(msg).not.toMatch(/rendered empty/);
  });
});
