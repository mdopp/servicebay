import { describe, it, expect } from 'vitest';
import { reportToProbe } from '@/lib/diagnose/probes/ssoVerify';
import type { SsoVerifyReport } from '@/lib/diagnose/ssoVerify';
import type { StoredSsoVerifyReport } from '@/lib/diagnose/ssoVerifyStore';

const at = '2026-06-01T12:00:00.000Z';
const wrap = (report: SsoVerifyReport): StoredSsoVerifyReport => ({ at, report });

const base = (over: Partial<SsoVerifyReport> = {}): SsoVerifyReport => ({
  ok: true,
  cleanedUp: true,
  ephemeralUser: 'sb-ssoverify-1-aa',
  steps: [{ id: 'create_user', status: 'pass', detail: 'created' }],
  userDomains: [
    { domain: 'vault.example.com', status: 'pass', code: 200, detail: 'HTTP 200' },
    { domain: 'photos.example.com', status: 'pass', code: 200, detail: 'HTTP 200' },
  ],
  adminDomains: [{ domain: 'nginx.example.com', status: 'pass', code: 302, detail: 'HTTP 302' }],
  ...over,
});

describe('reportToProbe', () => {
  it('returns info "not run yet" when there is no stored report', () => {
    const p = reportToProbe(null);
    expect(p.status).toBe('info');
    expect(p.detail).toMatch(/has not run yet/i);
    expect(p.items).toBeUndefined();
  });

  it('maps a fully-passing report to ok with per-domain ok items', () => {
    const p = reportToProbe(wrap(base()));
    expect(p.status).toBe('ok');
    expect(p.detail).toContain('2/2 user domains');
    expect(p.detail).toContain('1/1 admin domains');
    expect(p.items).toHaveLength(3);
    expect(p.items!.every(i => i.status === 'ok')).toBe(true);
    // items carry no per-row actions
    expect(p.items!.every(i => i.actionIds.length === 0)).toBe(true);
  });

  it('maps a failing user domain to fail with a failed item row', () => {
    const report = base({
      ok: false,
      userDomains: [
        { domain: 'vault.example.com', status: 'pass', code: 200, detail: 'HTTP 200' },
        { domain: 'photos.example.com', status: 'fail', code: 502, detail: 'HTTP 502' },
      ],
    });
    const p = reportToProbe(wrap(report));
    expect(p.status).toBe('fail');
    expect(p.detail).toContain('1/2 user domains');
    expect(p.hint).toBeDefined();
    const failItem = p.items!.find(i => i.label === 'photos.example.com');
    expect(failItem!.status).toBe('fail');
  });

  it('surfaces a failed step in the detail even when no domains were probed', () => {
    const report = base({
      ok: false,
      steps: [
        { id: 'family_group', status: 'pass', detail: 'present' },
        { id: 'authelia_firstfactor', status: 'fail', detail: 'firstfactor HTTP 401' },
      ],
      userDomains: [],
      adminDomains: [],
    });
    const p = reportToProbe(wrap(report));
    expect(p.status).toBe('fail');
    expect(p.detail).toContain('authelia_firstfactor');
    expect(p.detail).toContain('firstfactor HTTP 401');
    expect(p.items).toBeUndefined();
  });

  it('treats a config-skip report as info, not fail', () => {
    const report = base({
      ok: false,
      steps: [{ id: 'config', status: 'skip', detail: 'auth template not installed — nothing to verify.' }],
      userDomains: [],
      adminDomains: [],
    });
    const p = reportToProbe(wrap(report));
    expect(p.status).toBe('info');
    expect(p.detail).toContain('nothing to verify');
  });

  it('warns about an un-deleted ephemeral user', () => {
    const p = reportToProbe(wrap(base({ cleanedUp: false })));
    expect(p.detail).toContain('could not be deleted');
    expect(p.detail).toContain('sb-ssoverify-1-aa');
  });
});
