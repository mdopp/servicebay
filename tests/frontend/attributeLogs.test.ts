import { describe, it, expect } from 'vitest';
import { attributeLogs } from '@/components/StackInstallFlow';

describe('attributeLogs — install log per-service attribution (#822)', () => {
  it('attributes lines between `Installing X...` and `✅ X deployed` to X', () => {
    const logs = [
      'Install order (by dependencies): nginx → auth',
      'Installing nginx...',
      'pulling image…',
      'starting pod',
      '✅ nginx deployed (containers may still be starting in background).',
      'Installing auth...',
      'pulling LLDAP image',
      '✅ auth deployed on attempt 1/3.',
    ];
    const { perService, globalLines } = attributeLogs(logs);
    expect(perService.get('nginx')).toEqual([
      'Installing nginx...',
      'pulling image…',
      'starting pod',
      '✅ nginx deployed (containers may still be starting in background).',
    ]);
    expect(perService.get('auth')).toEqual([
      'Installing auth...',
      'pulling LLDAP image',
      '✅ auth deployed on attempt 1/3.',
    ]);
    expect(globalLines).toEqual(['Install order (by dependencies): nginx → auth']);
  });

  it('attributes post-deploy script output to its service', () => {
    const logs = [
      'Installing immich...',
      '✅ immich deployed.',
      'Running immich post-deploy script…',
      'registered OIDC client',
      'seeded admin user',
    ];
    const { perService, globalLines } = attributeLogs(logs);
    expect(perService.get('immich')).toEqual(logs);
    expect(globalLines).toEqual([]);
  });

  it('keeps lines outside any service block in globalLines', () => {
    const logs = [
      'Preparing manifest…',
      'Validating templates',
      'Installing vaultwarden...',
      'pulling image',
      '✅ vaultwarden deployed.',
      'Cleaning up temporary files',
    ];
    const { perService, globalLines } = attributeLogs(logs);
    expect(perService.get('vaultwarden')).toEqual([
      'Installing vaultwarden...',
      'pulling image',
      '✅ vaultwarden deployed.',
    ]);
    expect(globalLines).toEqual([
      'Preparing manifest…',
      'Validating templates',
      'Cleaning up temporary files',
    ]);
  });

  it('handles an in-progress service (no closing line yet)', () => {
    const logs = [
      'Installing radicale...',
      'pulling image',
      'still pulling…',
    ];
    const { perService, globalLines } = attributeLogs(logs);
    expect(perService.get('radicale')).toEqual(logs);
    expect(globalLines).toEqual([]);
  });

  it('empty log → empty maps', () => {
    const { perService, globalLines } = attributeLogs([]);
    expect(perService.size).toBe(0);
    expect(globalLines).toEqual([]);
  });
});
