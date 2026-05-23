import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateResetCombo } from './resetValidation';

// Mock the stack manifest loader so tests don't depend on the filesystem.
vi.mock('../template/stackContract', () => ({
  loadStackManifestsWithSelfHeal: vi.fn().mockResolvedValue([
    {
      name: 'cloud',
      label: 'Cloud',
      tier: 'feature',
      lifecycle: 'wipeable',
      dependsOnStacks: ['basic'],
      templates: ['vaultwarden', 'immich', 'radicale'],
      selfHeal: {
        vaultwarden: 'env_override',
        immich: 'env_override',
        radicale: 'none',
      },
    },
    {
      name: 'basic',
      label: 'Core',
      tier: 'core',
      lifecycle: 'atomic-wipe',
      dependsOnStacks: [],
      templates: ['nginx', 'auth', 'adguard'],
      selfHeal: {
        nginx: 'api_rotation',
        auth: 'recreate_on_key_wipe',
        adguard: 'env_override',
      },
    },
  ]),
}));

describe('validateResetCombo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts the default safe combination (preserve secrets, certs, identity)', async () => {
    const result = await validateResetCombo({
      preserve: ['secrets', 'certs', 'identity'],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts factory reset (wipe everything)', async () => {
    const result = await validateResetCombo({ preserve: [] });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects wiping secrets while preserving certs', async () => {
    const result = await validateResetCombo({
      preserve: ['certs'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some(e => e.includes('certificates'))).toBe(true);
  });

  it('rejects wiping secrets while preserving identity', async () => {
    const result = await validateResetCombo({
      preserve: ['identity'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('identity'))).toBe(true);
  });

  it('rejects wiping secrets while preserving certs AND identity (two errors)', async () => {
    const result = await validateResetCombo({
      preserve: ['certs', 'identity'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects dynamic selfHeal:none violation (radicale in service-data)', async () => {
    // Wipe secrets + keep service-data → radicale has selfHeal:none
    const result = await validateResetCombo({
      preserve: ['service-data'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('radicale'))).toBe(true);
  });

  it('accepts wiping secrets when service-data is also wiped (radicale goes away)', async () => {
    // Factory reset: wipe everything
    const result = await validateResetCombo({
      preserve: [],
    });
    expect(result.valid).toBe(true);
  });

  it('ignores unknown preserve group names silently', async () => {
    const result = await validateResetCombo({
      preserve: ['secrets', 'certs', 'identity', 'unknown-future-group'],
    });
    expect(result.valid).toBe(true);
  });

  it('accepts preserving secrets with any other group wiped', async () => {
    const result = await validateResetCombo({
      preserve: ['secrets'],
    });
    expect(result.valid).toBe(true);
  });
});
