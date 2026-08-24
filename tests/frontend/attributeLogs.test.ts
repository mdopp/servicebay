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

  // #2601 — the real log from the reference box. Everything after
  // `Installing media...` was attributed to the (collapsed-by-default) media
  // row, so the last line visible in the dialog's tail was the GREEN
  // dependency tick, with a finished run's buttons underneath it.
  it('lifts a ❌ failure line into the global tail instead of burying it in the row', () => {
    const logs = [
      'Captured LAN IP: 192.168.178.100',
      "Waiting for media's dependencies to become healthy: nginx, auth...",
      "✅ media's dependencies are healthy.",
      'Installing media...',
      '(note) media: no config backup found on the NAS — starting on existing/blank data.',
      '❌ Migration chain for media is incomplete: no script for v7→v8 (have v1, v3, v4, v5, v6). Aborting deploy.',
    ];
    const { perService, globalLines, failedServices } = attributeLogs(logs);

    // Visible without expanding anything — and it is the LAST line, not the tick.
    expect(globalLines[globalLines.length - 1]).toMatch(/^❌ Migration chain for media/);
    // Still in the row too, so the per-service view keeps its context.
    expect(perService.get('media')).toContain(logs[5]);
    expect(failedServices.has('media')).toBe(true);
  });

  it('a ❌ line outside any service block stays global and marks nothing failed', () => {
    const { globalLines, failedServices } = attributeLogs([
      'Installing nginx...',
      '✅ nginx deployed.',
      '❌ Nothing was deployed: 0 of 1 requested service(s) reached the box (media).',
    ]);
    expect(globalLines).toEqual(['❌ Nothing was deployed: 0 of 1 requested service(s) reached the box (media).']);
    expect(failedServices.size).toBe(0);
  });

  it('closes the service block so later lines are global again', () => {
    const { perService, globalLines } = attributeLogs([
      'Installing media...',
      '❌ Install stopped at media: boom',
      'Provisioning AdGuard DNS rewrites + portal routing...',
    ]);
    expect(perService.get('media')).toEqual(['Installing media...', '❌ Install stopped at media: boom']);
    expect(globalLines).toEqual([
      '❌ Install stopped at media: boom',
      'Provisioning AdGuard DNS rewrites + portal routing...',
    ]);
  });
});
