/**
 * #2756 — `restore_trashed_service` moved the Quadlet + YAML back, reloaded
 * systemd, re-provisioned the neighbours … and then stopped. Nothing started
 * the unit the delete had stopped, so a restore handed back a service that
 * `list_services` showed as present and correctly wired while its systemd unit
 * sat `inactive/dead` — a manual `manage_service start` was the only cure.
 *
 * The fix starts the unit and waits for it the way the deploy path waits, and
 * reports one of four honest states. These tests pin both halves of the
 * acceptance: the unit really is started (and reported `active` once systemd
 * says so), and a unit that has not come up inside the bound is reported as
 * `converging` — a poll-me answer that a caller can tell apart from both a
 * dead unit and an already-running one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendCommand = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand, pullImage: async () => undefined }),
    },
}));
vi.mock('../capabilities/serviceLifecycleEvents', () => ({
    reconstructTemplateVariables: async () => [],
    emitFeatureUninstalling: async () => [],
    emitFeatureUninstalled: async () => [],
    emitFeatureRestored: async () => [],
    recordCapabilityOutcome: async () => undefined,
}));

import { ServiceLifecycle } from './serviceLifecycle';
import { START_SETTLE_TUNING, type ServiceRunState } from './lifecycle/units';

const TRASH_ID = '2026-09-03T09-15-00-000Z-radicale';
const SERVICE = 'radicale';

const MANIFEST = JSON.stringify({
    service: SERVICE,
    deletedAt: '2026-09-03T09:15:00.000Z',
    originalYamlPath: '.config/containers/systemd/radicale.yml',
    originalKubePath: '~/.config/containers/systemd/radicale.kube',
});

/** `systemctl show` stdout for a given run-state. */
function showOutput(s: Partial<ServiceRunState>): string {
    return [
        `ActiveState=${s.activeState ?? 'inactive'}`,
        `SubState=${s.subState ?? 'dead'}`,
        `InvocationID=${s.invocationId ?? ''}`,
        `ActiveEnterTimestampMonotonic=${s.activeEnterStamp ?? '0'}`,
    ].join('\n') + '\n';
}

const DEAD: Partial<ServiceRunState> = { activeState: 'inactive', subState: 'dead', invocationId: '', activeEnterStamp: '0' };

/**
 * Drive the mocked agent: the manifest read answers with `MANIFEST`, every
 * `systemctl show` answers with the next state in `states` (the last one
 * repeats forever), everything else is a plain success.
 */
function agentWithStates(states: Partial<ServiceRunState>[]): void {
    let shown = 0;
    mockSendCommand.mockImplementation(async (action: string, args?: { command?: string }) => {
        const command = args?.command ?? '';
        if (action === 'exec' && command.includes('.manifest.json') && command.startsWith('cat ')) {
            return { code: 0, stdout: MANIFEST, stderr: '' };
        }
        if (action === 'exec' && command.includes('systemctl --user show')) {
            const state = states[Math.min(shown, states.length - 1)];
            shown++;
            return { code: 0, stdout: showOutput(state), stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    });
}

/** Every `exec` command string the restore issued. */
function issuedCommands(): string[] {
    return mockSendCommand.mock.calls
        .filter(([action]) => action === 'exec')
        .map(([, args]) => (args as { command?: string })?.command ?? '');
}

const originalTuning = { ...START_SETTLE_TUNING };

beforeEach(() => {
    mockSendCommand.mockReset();
    // Poll fast so a "slow start" is simulated in poll counts, not seconds.
    START_SETTLE_TUNING.pollIntervalMs = 1;
    START_SETTLE_TUNING.timeoutMs = 50;
});

afterEach(() => {
    Object.assign(START_SETTLE_TUNING, originalTuning);
});

describe('restoreTrashedService — the restored unit is started (#2756)', () => {
    it('issues a start and reports active once systemd shows a new running run', async () => {
        agentWithStates([
            DEAD,                                                                             // pre-start sample
            { activeState: 'activating', subState: 'start', invocationId: 'NEW', activeEnterStamp: '0' },
            { activeState: 'active', subState: 'running', invocationId: 'NEW', activeEnterStamp: '900' },
        ]);

        const res = await ServiceLifecycle.restoreTrashedService('local', TRASH_ID);

        expect(res.service).toBe(SERVICE);
        expect(issuedCommands()).toContain(`systemctl --user --no-block start ${SERVICE}.service`);
        expect(res.startup.state).toBe('active');
        expect(res.startup.alreadyActive).toBe(false);
        expect(res.startup.runState.activeState).toBe('active');
        expect(res.startup.detail).toMatch(/active\/running/);
    });

    it('still moves the quadlet + yaml back and reloads systemd before starting', async () => {
        agentWithStates([DEAD, { activeState: 'active', subState: 'running', invocationId: 'NEW', activeEnterStamp: '900' }]);

        await ServiceLifecycle.restoreTrashedService('local', TRASH_ID);

        const commands = issuedCommands();
        expect(commands.some(c => c.includes(`${TRASH_ID}/${SERVICE}.kube`))).toBe(true);
        expect(commands.some(c => c.includes(`${TRASH_ID}/radicale.yml`))).toBe(true);
        const reloadAt = commands.findIndex(c => c.includes('daemon-reload'));
        const startAt = commands.findIndex(c => c.includes('--no-block start'));
        expect(reloadAt).toBeGreaterThanOrEqual(0);
        expect(startAt).toBeGreaterThan(reloadAt);
    });
});

describe('restoreTrashedService — a unit that has not come up is reported as converging (#2756)', () => {
    it('reports converging, not active, when the pod is still booting at the bound', async () => {
        agentWithStates([DEAD, { activeState: 'activating', subState: 'start', invocationId: 'NEW', activeEnterStamp: '0' }]);

        const res = await ServiceLifecycle.restoreTrashedService('local', TRASH_ID);

        expect(res.startup.state).toBe('converging');
        expect(res.startup.detail).toMatch(/still starting/);
        // The caller must be able to tell this apart from a healthy unit.
        expect(res.startup.state).not.toBe('active');
        expect(issuedCommands()).toContain(`systemctl --user --no-block start ${SERVICE}.service`);
    });

    it('reports failed — not converging — when systemd says the unit failed', async () => {
        agentWithStates([DEAD, { activeState: 'failed', subState: 'failed', invocationId: 'NEW', activeEnterStamp: '0' }]);

        const res = await ServiceLifecycle.restoreTrashedService('local', TRASH_ID);

        expect(res.startup.state).toBe('failed');
        expect(res.startup.detail).toMatch(/failed to start/);
    });

    it('reports an already-running unit as active without issuing a start', async () => {
        agentWithStates([{ activeState: 'active', subState: 'running', invocationId: 'OLD', activeEnterStamp: '100' }]);

        const res = await ServiceLifecycle.restoreTrashedService('local', TRASH_ID);

        expect(res.startup.state).toBe('active');
        expect(res.startup.alreadyActive).toBe(true);
        expect(res.startup.waitedMs).toBe(0);
        expect(issuedCommands().some(c => c.includes('--no-block start'))).toBe(false);
    });

    it('reports error — and does not throw away the restore — when the start is refused', async () => {
        let shown = 0;
        mockSendCommand.mockImplementation(async (action: string, args?: { command?: string }) => {
            const command = args?.command ?? '';
            if (action === 'exec' && command.includes('.manifest.json') && command.startsWith('cat ')) {
                return { code: 0, stdout: MANIFEST, stderr: '' };
            }
            if (action === 'exec' && command.includes('systemctl --user show')) {
                shown++;
                return { code: 0, stdout: showOutput(DEAD), stderr: '' };
            }
            if (action === 'exec' && command.includes('--no-block start')) {
                return { code: 1, stdout: '', stderr: 'Unit radicale.service not found.' };
            }
            return { code: 0, stdout: '', stderr: '' };
        });

        const res = await ServiceLifecycle.restoreTrashedService('local', TRASH_ID);

        expect(res.service).toBe(SERVICE);
        expect(res.startup.state).toBe('error');
        expect(res.startup.detail).toMatch(/not found/);
        // Only the pre-start sample — no settle wait after a refused start.
        expect(shown).toBe(1);
    });
});
