/**
 * The post-install SSO self-test (#1454). It is fired detached from the
 * runner, so the only contract that matters is: it saves the report, it says
 * which way the check went, and it NEVER throws back into the install.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
vi.mock('./context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
}));

const verifySsoMock = vi.fn();
vi.mock('@/lib/diagnose/ssoVerify', () => ({ verifySso: (a: unknown) => verifySsoMock(a) }));

const saveReportMock = vi.fn();
vi.mock('@/lib/diagnose/ssoVerifyStore', () => ({
  saveSsoVerifyReport: (r: unknown) => saveReportMock(r),
}));

import { runSelfTestPhase } from './selfTest';

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  verifySsoMock.mockReset();
  saveReportMock.mockReset().mockResolvedValue(undefined);
});

describe('runSelfTestPhase', () => {
  it('verifies against the install node and persists the report', async () => {
    const report = { ok: true, cleanedUp: true };
    verifySsoMock.mockResolvedValue(report);

    await runSelfTestPhase('job1', 'Local');

    expect(verifySsoMock).toHaveBeenCalledWith({ node: 'Local' });
    expect(saveReportMock).toHaveBeenCalledWith(report);
    expect(logMock.mock.calls[0][1]).toMatch(/^SSO verification passed/);
  });

  it('reports findings — and whether the ephemeral user was cleaned up', async () => {
    // The ephemeral user is created by the check itself; an operator who sees
    // findings needs to know whether one was left behind on their box.
    verifySsoMock.mockResolvedValue({ ok: false, cleanedUp: false });

    await runSelfTestPhase('job1', undefined);

    expect(verifySsoMock).toHaveBeenCalledWith({ node: undefined });
    const line = logMock.mock.calls[0][1];
    expect(line).toContain('finished with findings');
    expect(line).toContain('Ephemeral user cleaned up: false');
  });

  it('swallows a failure into a job-log note — the install is already done', async () => {
    verifySsoMock.mockRejectedValue(new Error('auth unreachable'));

    await expect(runSelfTestPhase('job1', 'Local')).resolves.toBeUndefined();

    expect(saveReportMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      'job1',
      '(note) post-install SSO verification did not complete: auth unreachable',
    );
  });
});
