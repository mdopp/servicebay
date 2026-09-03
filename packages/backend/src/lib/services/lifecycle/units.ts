/**
 * systemd unit control for a managed service (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`: start / stop / restart /
 * daemon-reload plus the run-state sampling and the post-restart readiness
 * wait. Nothing here knows about templates, quadlet files or the trash bin —
 * it is the thinnest layer over `systemctl --user`.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';

/** A single systemd run-state sample of a unit. See readServiceRunState (#2406). */
export interface ServiceRunState {
    /** `active` | `activating` | `deactivating` | `inactive` | `failed` | '' (unreadable). */
    activeState: string;
    /** `running` | `start` | `dead` | … — for a `.kube` unit, `running` means kube-play finished. */
    subState: string;
    /** systemd's per-activation id; changes on every (re)start. '' when unreadable. */
    invocationId: string;
    /** Monotonic µs of the last activation; secondary discriminator when InvocationID is unavailable. */
    activeEnterStamp: string;
}

/** Outcome of the post-restart readiness wait (#2406). */
export interface RestartSettleResult {
    /** True only when the unit came back up as a NEW run within the bound. */
    settled: boolean;
    reason: 'active' | 'timeout' | 'failed';
    waitedMs: number;
    polls: number;
    state: ServiceRunState;
}

/**
 * Bound + cadence for the post-restart readiness wait (#2406). A `.kube`
 * unit's restart is a full pod teardown + kube-play, which on a slow box with
 * large images is minutes, not seconds — hence the generous bound. Mutable so
 * tests can shrink the poll without faking timers.
 */
export const RESTART_SETTLE_TUNING = { timeoutMs: 180_000, pollIntervalMs: 2_000 };

export async function startService(nodeName: string, serviceName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block start ${serviceName}.service` });
    if (res.code !== 0) throw new Error(res.stderr);
}

export async function stopService(nodeName: string, serviceName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block stop ${serviceName}.service` });
    if (res.code !== 0) throw new Error(res.stderr);
}

export async function restartService(nodeName: string, serviceName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block restart ${serviceName}.service` });
    if (res.code !== 0) throw new Error(res.stderr);
}

export async function reloadDaemon(nodeName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const res = await agent.sendCommand('exec', { command: 'systemctl --user daemon-reload' });
    if (res.code !== 0) throw new Error(res.stderr);
}

/**
 * Whether `<serviceName>.service` is currently active (running). Used by
 * the deploy path to choose start-vs-restart: `systemctl start` on an
 * already-active unit is a no-op, so a re-deploy that changed the pod
 * spec would leave the old topology running (#1813). Best-effort —
 * any error is treated as "not active" so the deploy falls back to a
 * plain start.
 */
export async function isServiceActive(nodeName: string, serviceName: string): Promise<boolean> {
    try {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', {
            command: `systemctl --user is-active ${serviceName}.service`,
        });
        return (res?.stdout ?? '').trim() === 'active';
    } catch {
        return false;
    }
}

/**
 * One sample of a unit's systemd run-state, used to decide whether a
 * restart has actually settled (#2406).
 *
 * `invocationId` / `activeEnterStamp` are the discriminators that make
 * this more than an `is-active` check: right after `systemctl --no-block
 * restart` the unit still reports the OLD run as `active`, so polling
 * `is-active` alone returns true immediately and doesn't wait for
 * anything. Both values change on every (re)activation, so "active AND a
 * different invocation than before the restart" is the first moment the
 * NEW pod is up.
 */
export async function readServiceRunState(nodeName: string, serviceName: string): Promise<ServiceRunState> {
    try {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', {
            command: `systemctl --user show ${serviceName}.service --property=ActiveState --property=SubState --property=InvocationID --property=ActiveEnterTimestampMonotonic`,
        });
        const out = String(res?.stdout ?? '');
        const prop = (key: string) => (out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim();
        return {
            activeState: prop('ActiveState'),
            subState: prop('SubState'),
            invocationId: prop('InvocationID'),
            activeEnterStamp: prop('ActiveEnterTimestampMonotonic'),
        };
    } catch {
        return { activeState: '', subState: '', invocationId: '', activeEnterStamp: '' };
    }
}

/**
 * Block until `<serviceName>.service` has come back up after a restart —
 * or until the bound is hit (#2406).
 *
 * Why this exists: `restartService` uses `--no-block`, which returns as
 * soon as systemd has *queued* the job. Everything the deploy path does
 * next (notably the template's post-deploy script) therefore ran
 * concurrently with the pod's own restart — containers gone, coming up,
 * or `podman` calls timing out against a pod being rebuilt. Three
 * consecutive workarounds downstream (mdopp/solarisbay#1090/#1097/#1099:
 * `Pull=newer`, an in-script `podman exec` probe, an in-script
 * `/health` wait) each lost that race in a different way, because the
 * race is in ServiceBay's deploy sequence, not in the scripts.
 *
 * The wait is a real readiness check, not a sleep: poll the unit's
 * systemd state until it reports `active`/`running` with an invocation
 * *different* from the pre-restart sample. A `failed` unit returns
 * immediately (no point waiting out the bound), and the bound itself is
 * hard — we return `settled:false` with a reason and the caller logs it
 * loudly. Never throws; the deploy continues either way, but the install
 * log now says which of the two happened.
 */
export async function waitForRestartSettled(
    nodeName: string,
    serviceName: string,
    before: ServiceRunState,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<RestartSettleResult> {
    const timeoutMs = opts?.timeoutMs ?? RESTART_SETTLE_TUNING.timeoutMs;
    const pollIntervalMs = opts?.pollIntervalMs ?? RESTART_SETTLE_TUNING.pollIntervalMs;
    const startedAt = Date.now();
    let state: ServiceRunState = before;
    let polls = 0;

    for (;;) {
        state = await readServiceRunState(nodeName, serviceName);
        polls++;
        const isNewRun =
            (state.invocationId !== '' && state.invocationId !== before.invocationId) ||
            (state.activeEnterStamp !== '' && state.activeEnterStamp !== before.activeEnterStamp);
        if (state.activeState === 'active' && state.subState === 'running' && isNewRun) {
            return { settled: true, reason: 'active', waitedMs: Date.now() - startedAt, polls, state };
        }
        if (state.activeState === 'failed') {
            return { settled: false, reason: 'failed', waitedMs: Date.now() - startedAt, polls, state };
        }
        if (Date.now() - startedAt >= timeoutMs) {
            return { settled: false, reason: 'timeout', waitedMs: Date.now() - startedAt, polls, state };
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
}

export async function ensurePodmanSocket(nodeName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    try {
        const res = await agent.sendCommand('exec', { command: 'systemctl --user enable --now podman.socket' });
        if (res.code === 0) {
            logger.info('ServiceManager', 'podman.socket enabled');
        } else {
            logger.warn('ServiceManager', 'Failed to enable podman.socket:', res.stderr);
        }
    } catch (e) {
        logger.warn('ServiceManager', 'Error enabling podman.socket:', e);
    }
}

/** Allow rootless Podman to bind privileged ports (e.g. 445 for SMB). Idempotent. */
export async function ensureUnprivilegedPorts(nodeName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    try {
        const check = await agent.sendCommand('exec', { command: 'cat /proc/sys/net/ipv4/ip_unprivileged_port_start' });
        if (check.code === 0 && parseInt(check.stdout.trim(), 10) === 0) return;
        // Set at runtime
        await agent.sendCommand('exec', { command: 'sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0' });
        // Persist across reboots
        await agent.sendCommand('exec', {
            command: 'echo "net.ipv4.ip_unprivileged_port_start=0" | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf > /dev/null'
        });
        logger.info('ServiceManager', 'Enabled unprivileged port binding (sysctl)');
    } catch (e) {
        logger.warn('ServiceManager', 'Error setting unprivileged port sysctl:', e);
    }
}
