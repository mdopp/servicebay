import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #2406 — a template's post-deploy script ran *while* ServiceBay was still
 * restarting that template's own pod: `systemctl --user --no-block restart`
 * returns as soon as the job is queued, and the deploy path went straight on
 * to post-deploy. Anything the script asked about its own pod hit a moving
 * target (containers gone / coming up / `podman` timing out against a pod
 * being rebuilt) — three downstream workarounds lost that race in three
 * different ways (mdopp/solarisbay#1090/#1097/#1099).
 *
 * The fix waits for the unit to genuinely be back up before continuing. These
 * tests pin (a) the readiness primitive's semantics — including the trap that
 * makes a naive `is-active` poll useless — and (b) the deploy-level ordering:
 * post-deploy is invoked only after the restart settled.
 */

const mockSendCommand = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand, pullImage: async () => undefined }),
    },
}));
vi.mock('@/lib/auth/internalToken', () => ({ getInternalApiToken: () => 'INTERNAL_HMAC' }));
vi.mock('@/lib/auth/apiTokens', () => ({
    createToken: async () => ({ token: { id: 'aa11', name: 'postdeploy-read:solaris' }, secret: 'sb_read_secret' }),
    listTokens: async () => [],
    revokeToken: async () => true,
}));

import { ServiceLifecycle, RESTART_SETTLE_TUNING, type ServiceRunState } from './serviceLifecycle';

const SOLARIS_YAML = `
apiVersion: v1
kind: Pod
metadata:
  name: solaris
spec:
  containers:
    - name: chat
      image: docker.io/library/solaris:latest
`;

/** `systemctl show` stdout for a given run-state. */
function showOutput(s: Partial<ServiceRunState>): string {
    return [
        `ActiveState=${s.activeState ?? 'inactive'}`,
        `SubState=${s.subState ?? 'dead'}`,
        `InvocationID=${s.invocationId ?? ''}`,
        `ActiveEnterTimestampMonotonic=${s.activeEnterStamp ?? '0'}`,
    ].join('\n') + '\n';
}

const OLD_RUN: ServiceRunState = {
    activeState: 'active', subState: 'running', invocationId: 'OLD', activeEnterStamp: '100',
};

const originalTuning = { ...RESTART_SETTLE_TUNING };

beforeEach(() => {
    mockSendCommand.mockReset();
    // Poll fast so a "slow restart" is simulated in poll counts, not seconds.
    RESTART_SETTLE_TUNING.pollIntervalMs = 1;
    RESTART_SETTLE_TUNING.timeoutMs = 2_000;
});

afterEach(() => {
    Object.assign(RESTART_SETTLE_TUNING, originalTuning);
});

describe('readServiceRunState (#2406)', () => {
    it('parses the four systemd properties in one show call', async () => {
        mockSendCommand.mockResolvedValue({
            code: 0,
            stdout: showOutput({ activeState: 'active', subState: 'running', invocationId: 'abc123', activeEnterStamp: '42' }),
            stderr: '',
        });
        await expect(ServiceLifecycle.readServiceRunState('local', 'solaris')).resolves.toEqual({
            activeState: 'active', subState: 'running', invocationId: 'abc123', activeEnterStamp: '42',
        });
        expect(mockSendCommand).toHaveBeenCalledWith('exec', {
            command: 'systemctl --user show solaris.service --property=ActiveState --property=SubState --property=InvocationID --property=ActiveEnterTimestampMonotonic',
        });
    });

    it('returns an empty sample when the agent call throws (best-effort)', async () => {
        mockSendCommand.mockRejectedValue(new Error('agent down'));
        await expect(ServiceLifecycle.readServiceRunState('local', 'solaris')).resolves.toEqual({
            activeState: '', subState: '', invocationId: '', activeEnterStamp: '',
        });
    });
});

describe('waitForRestartSettled (#2406)', () => {
    /**
     * Simulate a restart that takes time: the first `slowPolls` samples still
     * show the OLD run (or the teardown), then the NEW invocation comes up.
     */
    function simulateRestart(slowPolls: number, tail: Partial<ServiceRunState>[] = []) {
        let n = 0;
        mockSendCommand.mockImplementation(async () => {
            const stages: Partial<ServiceRunState>[] = [
                // The trap: immediately after `--no-block restart`, systemd
                // still reports the OLD run as active/running.
                ...Array.from({ length: slowPolls }, (_, i) =>
                    i === 0
                        ? { activeState: 'active', subState: 'running', invocationId: 'OLD', activeEnterStamp: '100' }
                        : { activeState: 'activating', subState: 'start', invocationId: 'NEW', activeEnterStamp: '0' }),
                ...(tail.length ? tail : [{ activeState: 'active', subState: 'running', invocationId: 'NEW', activeEnterStamp: '900' }]),
            ];
            const stage = stages[Math.min(n, stages.length - 1)];
            n++;
            return { code: 0, stdout: showOutput(stage), stderr: '' };
        });
    }

    it('does NOT settle on the old run still reported active (the #2406 race)', async () => {
        simulateRestart(4);
        const res = await ServiceLifecycle.waitForRestartSettled('local', 'solaris', OLD_RUN);
        expect(res.settled).toBe(true);
        expect(res.reason).toBe('active');
        // It kept polling past the stale-active sample and the activating ones.
        expect(res.polls).toBe(5);
        expect(res.state.invocationId).toBe('NEW');
    });

    it('settles on the very first poll when the new run is already up', async () => {
        simulateRestart(0);
        const res = await ServiceLifecycle.waitForRestartSettled('local', 'solaris', OLD_RUN);
        expect(res).toMatchObject({ settled: true, reason: 'active', polls: 1 });
    });

    it('treats a changed ActiveEnterTimestamp as a new run when InvocationID is unavailable', async () => {
        mockSendCommand.mockResolvedValue({
            code: 0,
            stdout: showOutput({ activeState: 'active', subState: 'running', invocationId: '', activeEnterStamp: '900' }),
            stderr: '',
        });
        const res = await ServiceLifecycle.waitForRestartSettled('local', 'solaris', OLD_RUN);
        expect(res.settled).toBe(true);
    });

    it('returns immediately (unsettled) when the unit comes back failed', async () => {
        mockSendCommand.mockResolvedValue({
            code: 0,
            stdout: showOutput({ activeState: 'failed', subState: 'failed', invocationId: 'NEW', activeEnterStamp: '900' }),
            stderr: '',
        });
        const res = await ServiceLifecycle.waitForRestartSettled('local', 'solaris', OLD_RUN);
        expect(res).toMatchObject({ settled: false, reason: 'failed', polls: 1 });
    });

    it('is bounded — a unit that never comes up ends in an explicit timeout, not an indefinite wait', async () => {
        mockSendCommand.mockResolvedValue({
            code: 0,
            stdout: showOutput({ activeState: 'activating', subState: 'start', invocationId: 'NEW', activeEnterStamp: '0' }),
            stderr: '',
        });
        const res = await ServiceLifecycle.waitForRestartSettled('local', 'solaris', OLD_RUN, {
            timeoutMs: 25, pollIntervalMs: 1,
        });
        expect(res).toMatchObject({ settled: false, reason: 'timeout' });
        expect(res.waitedMs).toBeGreaterThanOrEqual(25);
        expect(res.polls).toBeGreaterThan(1);
    });

    it('never throws when the unit is unreadable — it bounds out instead', async () => {
        mockSendCommand.mockRejectedValue(new Error('podman busy, exec timed out'));
        const res = await ServiceLifecycle.waitForRestartSettled('local', 'solaris', OLD_RUN, {
            timeoutMs: 10, pollIntervalMs: 1,
        });
        expect(res).toMatchObject({ settled: false, reason: 'timeout' });
    });
});

describe('deployKubeService — post-deploy runs AFTER the restart settled (#2406)', () => {
    /**
     * Drive the real deploy path with a mocked agent and assert the command
     * timeline: restart → readiness polls → post-deploy. Before the fix the
     * post-deploy `mkdir` landed straight after the restart, with no poll in
     * between.
     */
    function driveDeploy(restartPolls: number) {
        const timeline: string[] = [];
        let shows = 0;
        mockSendCommand.mockImplementation(async (action: string, params: unknown) => {
            if (action !== 'exec') {
                timeline.push(`write_file:${(params as { path?: string })?.path ?? ''}`);
                return 'ok';
            }
            const cmd = (params as { command?: string })?.command ?? '';
            timeline.push(cmd);
            if (/systemctl --user is-active/.test(cmd)) {
                return { code: 0, stdout: 'active\n', stderr: '' };
            }
            if (/systemctl --user show/.test(cmd)) {
                shows++;
                // First `show` is the pre-restart sample; then `restartPolls`
                // samples that still show the old run; then the new run.
                const stage: Partial<ServiceRunState> = shows <= restartPolls + 1
                    ? { activeState: 'active', subState: 'running', invocationId: 'OLD', activeEnterStamp: '100' }
                    : { activeState: 'active', subState: 'running', invocationId: 'NEW', activeEnterStamp: '900' };
                return { code: 0, stdout: showOutput(stage), stderr: '' };
            }
            if (/\.container && echo present/.test(cmd)) {
                return { code: 0, stdout: 'absent\n', stderr: '' };
            }
            return { code: 0, stdout: '', stderr: '' };
        });
        return timeline;
    }

    const deploy = (onProgress?: (m: string) => void) =>
        ServiceLifecycle.deployKubeService(
            'local', 'solaris',
            '[Kube]\nYaml=solaris.yml\n',
            SOLARIS_YAML,
            'solaris.yml',
            undefined,
            onProgress,
            'print("post-deploy")',
            {},
        );

    it('does not invoke post-deploy until the restarted unit reports a new active run', async () => {
        const timeline = driveDeploy(3);
        await deploy();

        const restartAt = timeline.findIndex(c => /--no-block restart solaris\.service/.test(c));
        const postDeployAt = timeline.findIndex(c => /mkdir -p ~\/\.local\/share\/servicebay\/post-deploy/.test(c));
        expect(restartAt).toBeGreaterThanOrEqual(0);
        expect(postDeployAt).toBeGreaterThan(restartAt);

        // The readiness polls sit BETWEEN the restart and post-deploy — this is
        // the assertion that fails without the fix (they'd be adjacent).
        const pollsBetween = timeline
            .slice(restartAt + 1, postDeployAt)
            .filter(c => /systemctl --user show solaris\.service/.test(c));
        expect(pollsBetween.length).toBeGreaterThanOrEqual(4);
    });

    it('logs whether post-deploy ran before or after the restart settled', async () => {
        driveDeploy(2);
        const lines: string[] = [];
        await deploy(m => lines.push(m));

        const settledIdx = lines.findIndex(l => /restart settled after .*s — unit active\/running/.test(l));
        const postDeployIdx = lines.findIndex(l => /Running solaris post-deploy script/.test(l));
        expect(settledIdx).toBeGreaterThanOrEqual(0);
        expect(postDeployIdx).toBeGreaterThan(settledIdx);
        expect(lines[settledIdx]).toMatch(/post-deploy, if any, runs AFTER the restart/);
    });

    it('reports an explicit timeout (and still continues) when the unit never comes back', async () => {
        // Every `show` keeps reporting the old run → the bound is hit.
        driveDeploy(Number.MAX_SAFE_INTEGER);
        RESTART_SETTLE_TUNING.timeoutMs = 15;
        const lines: string[] = [];
        await deploy(m => lines.push(m));

        expect(lines.some(l => /did not report active within .*s of the restart/.test(l))).toBe(true);
        // Deploy is not aborted — post-deploy still runs, but the log says why.
        expect(lines.some(l => /Running solaris post-deploy script/.test(l))).toBe(true);
    });

    it('adds no wait to the plain-start path (first install / unchanged render)', async () => {
        const timeline: string[] = [];
        mockSendCommand.mockImplementation(async (action: string, params: unknown) => {
            if (action !== 'exec') {
                // read_file of the previous quadlets returns the SAME content →
                // specChanged=false → plain start, no restart, no wait.
                const path = (params as { path?: string })?.path ?? '';
                if (action === 'read_file') {
                    if (path.endsWith('solaris.yml')) return SOLARIS_YAML;
                    if (path.endsWith('solaris.kube')) return '[Kube]\nYaml=solaris.yml\n';
                }
                return 'ok';
            }
            const cmd = (params as { command?: string })?.command ?? '';
            timeline.push(cmd);
            if (/\.container && echo present/.test(cmd)) return { code: 0, stdout: 'absent\n', stderr: '' };
            return { code: 0, stdout: '', stderr: '' };
        });

        await deploy();

        expect(timeline.some(c => /--no-block start solaris\.service/.test(c))).toBe(true);
        expect(timeline.some(c => /--no-block restart solaris\.service/.test(c))).toBe(false);
        expect(timeline.some(c => /systemctl --user show solaris\.service/.test(c))).toBe(false);
    });
});
