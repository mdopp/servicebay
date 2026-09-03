/**
 * The install runner's own job (#2742): the order of the phases and the
 * terminal verdict.
 *
 * `runner.test.ts` covers the pure helpers and pins the source shape of the
 * pieces that used to be unreachable. Now that the phases are separate
 * modules they can be stubbed, so the loop itself is testable — and the thing
 * worth testing is #2601: the verdict follows what actually reached the box,
 * not the fact that the loop ran to the end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobInput, JobState } from './jobStore';

const getJobMock = vi.fn<(id: string) => Promise<JobState | null>>();
vi.mock('./jobStore', () => ({ getJob: (id: string) => getJobMock(id) }));

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
const patchJobMock = vi.fn();
const isJobAbortedMock = vi.fn<(jobId: string) => boolean>();
const clearAbortFlagMock = vi.fn();
const markJobAbortedMock = vi.fn();
vi.mock('./phases/context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
  patchJob: (...args: unknown[]) => patchJobMock(...args),
  isJobAborted: (jobId: string) => isJobAbortedMock(jobId),
  clearJobAbortFlag: (jobId: string) => clearAbortFlagMock(jobId),
  markJobAborted: (jobId: string) => markJobAbortedMock(jobId),
}));

const preflightMock = vi.fn();
vi.mock('./phases/preflight', () => ({ runPreflightPhase: (...a: unknown[]) => preflightMock(...a) }));

const kubePlayMock = vi.fn();
vi.mock('./phases/kubePlay', () => ({ runKubePlayPhase: (...a: unknown[]) => kubePlayMock(...a) }));

const postDeployMock = vi.fn();
vi.mock('./phases/postDeploy', () => ({ runPostDeployPhase: (...a: unknown[]) => postDeployMock(...a) }));

const finalizeMock = vi.fn();
vi.mock('./phases/finalize', () => ({ runFinalizePhase: (...a: unknown[]) => finalizeMock(...a) }));

const selfTestMock = vi.fn();
vi.mock('./phases/selfTest', () => ({ runSelfTestPhase: (...a: unknown[]) => selfTestMock(...a) }));

const waitForDependenciesMock = vi.fn();
vi.mock('./phases/readiness', () => ({
  waitForDependencies: (...a: unknown[]) => waitForDependenciesMock(...a),
  isServiceReady: vi.fn(),
  settleWait: vi.fn(),
}));

const clearPendingCredentialsMock = vi.fn();
vi.mock('./credentialResolver', () => ({
  clearPendingCredentials: (jobId: string) => clearPendingCredentialsMock(jobId),
  provideCredentials: vi.fn(),
  skipCredentials: vi.fn(),
}));

vi.mock('./postInstallDispatcher', () => ({ ensureProxyHosts: vi.fn() }));
vi.mock('@/lib/registry', () => ({
  getTemplateMigrationScripts: vi.fn(),
  getTemplatePostDeployScript: vi.fn(),
  getTemplateYaml: vi.fn(),
  syncRegistries: vi.fn(),
}));

import { abortJob, startJob } from './runner';

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [{ name: 'media', checked: true }, { name: 'off', checked: false }],
  variables: [],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

const job = (over: Partial<JobInput> = {}) => ({ id: 'job1', input: input(over) } as JobState);

const selectedItem = (name: string, alreadyInstalled = false) =>
  ({ name, checked: true, alreadyInstalled, dependencies: [], tier: 'feature' });

/** Let the detached pipeline run to completion — every stub is a microtask. */
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

const lines = () => logMock.mock.calls.map(c => c[1]);
const patches = () => patchJobMock.mock.calls.map(c => c[1] as Record<string, unknown>);

beforeEach(() => {
  getJobMock.mockReset().mockResolvedValue(job());
  logMock.mockReset().mockResolvedValue(undefined);
  patchJobMock.mockReset().mockResolvedValue(null);
  isJobAbortedMock.mockReset().mockReturnValue(false);
  clearAbortFlagMock.mockReset();
  markJobAbortedMock.mockReset();
  preflightMock.mockReset().mockResolvedValue({ ok: true, selected: [selectedItem('media')] });
  kubePlayMock.mockReset().mockResolvedValue(true);
  postDeployMock.mockReset().mockResolvedValue({ aborted: false });
  finalizeMock.mockReset().mockResolvedValue(undefined);
  selfTestMock.mockReset().mockResolvedValue(undefined);
  waitForDependenciesMock.mockReset().mockResolvedValue(undefined);
  clearPendingCredentialsMock.mockReset();
});

describe('startJob — the happy path', () => {
  it('runs the phases in order and ends the job as done', async () => {
    startJob('job1');
    await flush();

    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(waitForDependenciesMock).toHaveBeenCalledWith('job1', expect.objectContaining({ name: 'media' }), 'Local');
    expect(kubePlayMock).toHaveBeenCalledTimes(1);
    expect(postDeployMock).toHaveBeenCalledTimes(1);
    expect(patches().at(-1)).toEqual({
      phase: 'done',
      endedAt: expect.any(String),
      progress: { currentItem: null, deployedNames: ['media'], totalCount: 1 },
    });
    // Finalize's writes are only allowed after the verdict is patched.
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(selfTestMock).toHaveBeenCalledWith('job1', undefined);
    expect(clearAbortFlagMock).toHaveBeenCalledWith('job1');
  });

  it('skips an already-installed item without deploying it, and still counts it as present', async () => {
    preflightMock.mockResolvedValue({
      ok: true,
      selected: [selectedItem('auth', true), selectedItem('media')],
    });

    startJob('job1');
    await flush();

    expect(lines()).toContain('✅ auth already installed, skipping.');
    expect(kubePlayMock).toHaveBeenCalledTimes(1);
    expect(patches().at(-1)).toMatchObject({
      phase: 'done',
      progress: expect.objectContaining({ deployedNames: ['auth', 'media'] }),
    });
  });

  it('does nothing at all for a job id that no longer exists', async () => {
    getJobMock.mockResolvedValue(null);
    startJob('gone');
    await flush();
    expect(preflightMock).not.toHaveBeenCalled();
    expect(patchJobMock).not.toHaveBeenCalled();
  });
});

describe('startJob — pre-flight outcomes', () => {
  it('ends a run that selected nothing as done, with an empty manifest', async () => {
    preflightMock.mockResolvedValue({ ok: false, kind: 'nothing-selected' });

    startJob('job1');
    await flush();

    expect(patches()).toEqual([{ phase: 'done', endedAt: expect.any(String), credentialsManifest: [] }]);
    expect(kubePlayMock).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('ends a refused pre-flight as an error carrying its message', async () => {
    preflightMock.mockResolvedValue({ ok: false, kind: 'error', message: 'Cannot install media: it depends on auth' });

    startJob('job1');
    await flush();

    expect(patches()).toEqual([{
      phase: 'error',
      endedAt: expect.any(String),
      error: 'Cannot install media: it depends on auth',
    }]);
  });
});

describe('startJob — the verdict follows what reached the box (#2601)', () => {
  it('is an error when the deploy returned false for every requested item', async () => {
    // The no-op upgrade that used to be indistinguishable from a real one.
    kubePlayMock.mockResolvedValue(false);

    startJob('job1');
    await flush();

    expect(lines()).toContain('❌ Nothing was deployed: 0 of 1 requested service(s) reached the box (media).');
    expect(patches().at(-1)).toMatchObject({
      phase: 'error',
      error: 'Nothing was deployed: 0 of 1 requested service(s) reached the box (media).',
    });
    // The post-install work still runs — only the verdict changes.
    expect(postDeployMock).toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalled();
  });

  it('reports a partial run as partial, naming both sides', async () => {
    preflightMock.mockResolvedValue({ ok: true, selected: [selectedItem('nginx'), selectedItem('media')] });
    kubePlayMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    startJob('job1');
    await flush();

    expect(lines()).toContain('❌ 1/2 requested service(s) deployed (nginx). NOT deployed: media.');
    expect(patches().at(-1)).toMatchObject({ phase: 'error' });
  });

  it('logs the stop BEFORE it patches the job when a deploy throws', async () => {
    // Pre-fix the catch patched `error` and returned without writing a line,
    // so the operator's last visible line was the green tick before it.
    kubePlayMock.mockRejectedValue(new Error('migration refusal'));

    startJob('job1');
    await flush();

    expect(lines()).toEqual([
      '❌ Install stopped at media: migration refusal',
      '❌ Nothing was deployed: 0 of 1 requested service(s) reached the box (media).',
    ]);
    expect(patches().at(-1)).toMatchObject({ phase: 'error', error: 'migration refusal' });
    // A run that stopped mid-loop does not get the post-install work.
    expect(postDeployMock).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});

describe('startJob — abort paths', () => {
  it('stops at the top of the loop once the operator aborts', async () => {
    isJobAbortedMock.mockReturnValue(true);

    startJob('job1');
    await flush();

    expect(kubePlayMock).not.toHaveBeenCalled();
    expect(patches()).toEqual([{ phase: 'aborted', endedAt: expect.any(String), error: 'Installation aborted by user.' }]);
    expect(lines()).toContain('⛔ Install aborted by user.');
  });

  it('re-checks the flag after the dependency wait — that wait can take minutes', async () => {
    isJobAbortedMock.mockReturnValueOnce(false).mockReturnValue(true);

    startJob('job1');
    await flush();

    expect(waitForDependenciesMock).toHaveBeenCalled();
    expect(kubePlayMock).not.toHaveBeenCalled();
    expect(patches().at(-1)).toMatchObject({ phase: 'aborted' });
  });

  it('marks the job aborted when the post-deploy credentials prompt was cancelled', async () => {
    postDeployMock.mockResolvedValue({ aborted: true });

    startJob('job1');
    await flush();

    expect(patches().at(-1)).toEqual({ phase: 'aborted', endedAt: expect.any(String) });
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(selfTestMock).not.toHaveBeenCalled();
  });

  it('abortJob raises the flag and unblocks a pending credentials prompt', () => {
    abortJob('job1');
    expect(markJobAbortedMock).toHaveBeenCalledWith('job1');
    expect(clearPendingCredentialsMock).toHaveBeenCalledWith('job1');
  });
});

describe('startJob — the outer safety net', () => {
  it('writes the internal error to the job LOG as well as the job state', async () => {
    preflightMock.mockRejectedValue(new Error('phase module blew up'));

    startJob('job1');
    await flush();

    expect(lines()).toContain('❌ Internal runner error: phase module blew up');
    expect(patches().at(-1)).toMatchObject({
      phase: 'error',
      error: 'Internal runner error: phase module blew up',
    });
  });

  it('always releases the per-job cross-cutting state', async () => {
    preflightMock.mockRejectedValue(new Error('boom'));

    startJob('job1');
    await flush();

    expect(clearAbortFlagMock).toHaveBeenCalledWith('job1');
    expect(clearPendingCredentialsMock).toHaveBeenCalledWith('job1');
  });
});
