 
import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1709 — a *manual* re-run of sso_verify must actually re-verify
// (call verifySso, persist a fresh report) instead of re-displaying the
// stale stored report. A *scheduled* tick stays read-only (store read,
// no ephemeral-user churn).

const verifySso = vi.fn();
const loadSsoVerifyReport = vi.fn();
const saveSsoVerifyReport = vi.fn();

vi.mock('@/lib/diagnose/ssoVerify', () => ({
  verifySso: (...args: unknown[]) => verifySso(...args),
}));

vi.mock('@/lib/diagnose/ssoVerifyStore', () => ({
  loadSsoVerifyReport: (...args: unknown[]) => loadSsoVerifyReport(...args),
  saveSsoVerifyReport: (...args: unknown[]) => saveSsoVerifyReport(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkSsoVerify } from './ssoVerify';
import type { SsoVerifyReport } from '@/lib/diagnose/ssoVerify';

const passingReport = (): SsoVerifyReport => ({
  ok: true,
  couldNotRun: false,
  cleanedUp: true,
  ephemeralUser: 'sb-ssoverify-1-aa',
  steps: [{ id: 'create_user', status: 'pass', detail: 'created' }],
  userDomains: [{ domain: 'vault.example.com', status: 'pass', code: 200, detail: 'HTTP 200' }],
  adminDomains: [{ domain: 'nginx.example.com', status: 'pass', code: 302, detail: 'HTTP 302' }],
});

const staleStored = {
  at: '2026-06-04T17:29:00.000Z',
  report: { ...passingReport(), ok: false },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkSsoVerify manual vs scheduled (#1709)', () => {
  it('manual re-run calls verifySso and persists a FRESH report with a current timestamp', async () => {
    const fresh = passingReport();
    verifySso.mockResolvedValueOnce(fresh);
    const freshAt = new Date().toISOString();
    saveSsoVerifyReport.mockImplementationOnce(async (report: SsoVerifyReport) => ({ at: freshAt, report }));

    const res = await checkSsoVerify({ manual: true, node: 'Local' });

    // Real verification ran...
    expect(verifySso).toHaveBeenCalledTimes(1);
    expect(verifySso).toHaveBeenCalledWith({ node: 'Local' });
    // ...the fresh report was persisted...
    expect(saveSsoVerifyReport).toHaveBeenCalledTimes(1);
    expect(saveSsoVerifyReport).toHaveBeenCalledWith(fresh);
    // ...the stale store read was NOT used as the source of truth...
    expect(loadSsoVerifyReport).not.toHaveBeenCalled();
    // ...and the rendered probe reflects the fresh (passing) report + timestamp.
    expect(res.status).toBe('ok');
    expect(res.detail).toContain(freshAt);
  });

  it('scheduled tick reads the store only — does NOT call verifySso', async () => {
    loadSsoVerifyReport.mockResolvedValueOnce(staleStored);

    const res = await checkSsoVerify(); // no manual flag → scheduled

    expect(verifySso).not.toHaveBeenCalled();
    expect(saveSsoVerifyReport).not.toHaveBeenCalled();
    expect(loadSsoVerifyReport).toHaveBeenCalledTimes(1);
    // Renders the stored report verbatim.
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('2026-06-04T17:29');
  });

  it('a manual verify failure falls back to the last stored report (row not erased)', async () => {
    verifySso.mockRejectedValueOnce(new Error('lldap unreachable'));
    loadSsoVerifyReport.mockResolvedValueOnce(staleStored);

    const res = await checkSsoVerify({ manual: true });

    expect(verifySso).toHaveBeenCalledTimes(1);
    expect(loadSsoVerifyReport).toHaveBeenCalledTimes(1);
    // Falls back to the stored (stale) report rather than a bare error.
    expect(res.status).toBe('fail');
  });
});
