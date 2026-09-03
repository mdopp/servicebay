/**
 * #2531 — operator-set NON-secret variables must survive a reinstall.
 * #2785 — and the RECORD of what each service deployed with must be complete,
 * per-service, and secret-free, so an unattended redeploy has something to
 * converge on (ADR 0012) instead of re-deriving every setting.
 *
 * The store's rules are the whole fix: record every per-service variable of a
 * successful run (with the default in force, and secrets by reference only),
 * hand back for REUSE only what the operator actually set (so a template can
 * still bump a default), forget it when they unset it (so a dropped value
 * never comes back), and never duplicate a secret in plaintext.
 */
import { describe, it, expect, vi } from 'vitest';

const updateConfig = vi.fn<(patch: unknown) => Promise<void>>(async () => undefined);
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({})),
  updateConfig: (patch: unknown) => updateConfig(patch),
}));

import {
  loadSavedVariables,
  loadServiceVariables,
  isOperatorSetVariable,
  computeInstalledVariables,
  persistInstalledVariables,
  findUnrecoveredVariables,
  buildUnrecoveredVariablesWarning,
} from './savedVariables';
import type { AppConfig, InstalledVariableRecord } from '@/lib/config';

const cfg = (installedVariables?: InstalledVariableRecord[]): AppConfig =>
  ({ installedVariables }) as AppConfig;

describe('loadSavedVariables', () => {
  it('flattens the stored list', () => {
    expect(loadSavedVariables(cfg([{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }])))
      .toEqual({ VAPID_PUBLIC_KEY: 'BKx' });
  });

  it('is empty for a config that has never stored any', () => {
    expect(loadSavedVariables(cfg())).toEqual({});
  });

  // #2785 — the record is wider than the reuse map. These three are RECORDED
  // (so `get_service_files` can show what the service runs with) and must
  // still not be handed back as values to override a template with.
  it('does not offer back a value that is merely the template default (#1297)', () => {
    expect(loadSavedVariables(cfg([
      { varName: 'PORT', value: '8080', service: 'solaris', default: '8080' },
    ]))).toEqual({});
  });

  it('does not offer back a secret reference', () => {
    expect(loadSavedVariables(cfg([
      { varName: 'SOLARIS_TTS_PASSWORD', value: '', service: 'solaris', kind: 'secret' },
    ]))).toEqual({});
  });

  it('offers back a recorded value that differs from the default', () => {
    expect(loadSavedVariables(cfg([
      { varName: 'PORT', value: '9000', service: 'solaris', default: '8080' },
    ]))).toEqual({ PORT: '9000' });
  });
});

describe('loadServiceVariables — the per-service readback (#2785)', () => {
  const stored: InstalledVariableRecord[] = [
    { varName: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', service: 'solaris', default: 'base' },
    { varName: 'SOLARIS_TTS_SPEAKER', value: 'thorsten', service: 'solaris', default: 'thorsten' },
    { varName: 'SOLARIS_TTS_PASSWORD', value: '', service: 'solaris', kind: 'secret' },
    { varName: 'IMMICH_PORT', value: '2283', service: 'immich', default: '2283' },
  ];

  it('returns the whole recorded set of one service, defaults included', () => {
    expect(loadServiceVariables(cfg(stored), 'solaris').map(e => e.varName)).toEqual([
      'SOLARIS_WHISPER_MODEL', 'SOLARIS_TTS_SPEAKER', 'SOLARIS_TTS_PASSWORD',
    ]);
  });

  it('never carries a secret value — the reference only', () => {
    const secret = loadServiceVariables(cfg(stored), 'solaris').find(e => e.kind === 'secret');
    expect(secret).toEqual({ varName: 'SOLARIS_TTS_PASSWORD', value: '', service: 'solaris', kind: 'secret' });
  });

  it('does not leak another service\'s variables', () => {
    expect(loadServiceVariables(cfg(stored), 'immich').map(e => e.varName)).toEqual(['IMMICH_PORT']);
  });

  it('is empty for a service that has never been installed', () => {
    expect(loadServiceVariables(cfg(stored), 'media')).toEqual([]);
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

  // #2785 — `install_template({variables: {...}})` routes the caller's values
  // through `prefilled`, which the assembler flags BOTH global and explicit.
  // Skipping them as "re-derives from config" is what silently dropped every
  // per-service value an unattended install chose.
  it('DOES count a caller-supplied global — an explicit value re-derives from nothing', () => {
    expect(isOperatorSetVariable({
      name: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', global: true, explicit: true,
      meta: { type: 'text', default: 'base' },
    })).toBe(true);
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
    expect(out).toEqual([{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx', default: '' }]);
  });

  it('removes the record when the operator clears the value', () => {
    const out = computeInstalledVariables(
      [{ name: 'VAPID_PUBLIC_KEY', value: '', meta: { type: 'text', default: '' } }],
      cfg([{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }]),
    );
    expect(out).toEqual([]);
  });

  // #2785 — this used to DROP the record, which is why a box that had a stack
  // installed knew nothing about the values it was running. The record stays;
  // what must not happen is offering the value back as an override, and that
  // is now the `default` field's job (asserted on `loadSavedVariables`).
  it('records a value that equals the default, but does not offer it for reuse (#1297)', () => {
    const out = computeInstalledVariables(
      [{ name: 'PORT', value: '8080', meta: { type: 'text', default: '8080', templateName: 'solaris' } }],
      cfg([{ varName: 'PORT', value: '9000', service: 'solaris', default: '8080' }]),
    );
    expect(out).toEqual([{ varName: 'PORT', value: '8080', service: 'solaris', default: '8080' }]);
    expect(loadSavedVariables(cfg(out))).toEqual({});
  });

  it('leaves variables from other templates untouched', () => {
    const out = computeInstalledVariables(
      [{ name: 'IMMICH_X', value: 'v', meta: { type: 'text', default: '', templateName: 'immich' } }],
      cfg([{ varName: 'AUTH_Y', value: 'kept', service: 'auth' }]),
    );
    expect(out).toEqual([
      { varName: 'AUTH_Y', value: 'kept', service: 'auth' },
      { varName: 'IMMICH_X', value: 'v', service: 'immich', default: '' },
    ]);
  });

  it('never writes a secret value into the plaintext store', () => {
    const out = computeInstalledVariables(
      [{ name: 'VAPID_PRIVATE_KEY', value: 'pem-body', meta: { type: 'secret', templateName: 'solaris' } }],
      cfg(),
    );
    // Recorded as a REFERENCE so the per-service set is complete (#2785) —
    // with the credential itself nowhere in the payload.
    expect(out).toEqual([{ varName: 'VAPID_PRIVATE_KEY', value: '', service: 'solaris', kind: 'secret' }]);
    expect(JSON.stringify(out)).not.toContain('pem-body');
  });

  it('drops a secret reference once the secret stops deploying', () => {
    const out = computeInstalledVariables(
      [{ name: 'VAPID_PRIVATE_KEY', value: '', meta: { type: 'secret' } }],
      cfg([{ varName: 'VAPID_PRIVATE_KEY', value: '', service: 'solaris', kind: 'secret' }]),
    );
    expect(out).toEqual([]);
  });

  // #2785 — the reported shape: a multi-variable stack installed through
  // `install_template`, whose per-service values all arrive global+explicit.
  it('captures the full per-service set of a multi-variable stack, not just globals', () => {
    const out = computeInstalledVariables(
      [
        // Box-wide, derived from config on every assemble — deliberately not recorded.
        { name: 'PUBLIC_DOMAIN', value: 'example.com', global: true, meta: { type: 'text' } },
        // Caller-supplied per-service values (`prefilled` ⇒ global + explicit).
        {
          name: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', global: true, explicit: true,
          meta: { type: 'text', default: 'base', templateName: 'solaris' },
        },
        {
          name: 'SOLARIS_TTS_SPEAKER', value: 'thorsten', global: true, explicit: true,
          meta: { type: 'text', default: 'thorsten', templateName: 'solaris' },
        },
        // A per-service secret: named, never valued.
        {
          name: 'SOLARIS_TTS_PASSWORD', value: 'hunter2',
          meta: { type: 'secret', templateName: 'solaris' },
        },
      ],
      cfg(),
    );
    expect(out).toEqual([
      { varName: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', service: 'solaris', default: 'base' },
      { varName: 'SOLARIS_TTS_SPEAKER', value: 'thorsten', service: 'solaris', default: 'thorsten' },
      { varName: 'SOLARIS_TTS_PASSWORD', value: '', service: 'solaris', kind: 'secret' },
    ]);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    // …and the value the caller chose is the one the next deploy reuses.
    expect(loadSavedVariables(cfg(out))).toEqual({ SOLARIS_WHISPER_MODEL: 'large-v3' });
  });

  it('carries service + default forward when a replayed manifest has no metadata', () => {
    const out = computeInstalledVariables(
      [{ name: 'SOLARIS_WHISPER_MODEL', value: 'large-v3' }],
      cfg([{ varName: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', service: 'solaris', default: 'base' }]),
    );
    expect(out).toEqual([
      { varName: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', service: 'solaris', default: 'base' },
    ]);
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
      installedVariables: [{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx', default: '' }],
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
