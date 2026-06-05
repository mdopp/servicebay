/**
 * Orphan-container reconcile (#1668).
 *
 * Covers the reconcile filter's strict orphan predicate:
 *  - a record whose managing unit is GONE + not running  → reconciled (rm);
 *  - a record whose managing unit is PRESENT             → KEPT;
 *  - a RUNNING record (incl. a hermes-style managed pod) → KEPT;
 *  - a record with no PODMAN_SYSTEMD_UNIT label          → KEPT.
 *
 * Plus the end-to-end reconcile pass against a mocked podman DB / executor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetPodmanPs, mockExecutor, mockGetExecutor } = vi.hoisted(() => ({
  mockGetPodmanPs: vi.fn(),
  mockExecutor: {
    exec: vi.fn(),
    execArgv: vi.fn(),
  },
  mockGetExecutor: vi.fn(),
}));

vi.mock('@/lib/manager', () => ({ getPodmanPs: (...a: unknown[]) => mockGetPodmanPs(...a) }));
vi.mock('@/lib/executor', () => ({ getExecutor: (...a: unknown[]) => mockGetExecutor(...a) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { ContainerRecord } from './reconcileOrphanContainers';

const {
  isOrphanedContainerRecord,
  containerDisplayName,
  reconcileOrphanContainers,
} = await import('./reconcileOrphanContainers');

beforeEach(() => {
  mockGetExecutor.mockReturnValue(mockExecutor);
  mockExecutor.execArgv.mockReset();
  mockGetPodmanPs.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- The pure orphan predicate (the reconcile filter) ---
describe('isOrphanedContainerRecord', () => {
  const ghost = {
    Id: 'abc123def456',
    Names: ['/hermes-hermes'],
    State: 'exited',
    Labels: { PODMAN_SYSTEMD_UNIT: 'hermes.service' },
  };

  it('reconciles a record whose unit is GONE and is exited', () => {
    // unit absent (managingUnitExists=false) + exited → orphan
    expect(isOrphanedContainerRecord(ghost, false)).toBe(true);
  });

  it('KEEPS a record whose managing unit is PRESENT', () => {
    // current hermes-style managed container: unit file present → keep
    expect(isOrphanedContainerRecord(ghost, true)).toBe(false);
  });

  it('KEEPS a RUNNING container even if the unit probe says gone', () => {
    // never remove a running container — the CURRENT hermes must survive
    const runningHermes = { ...ghost, State: 'running' };
    expect(isOrphanedContainerRecord(runningHermes, false)).toBe(false);
  });

  it('KEEPS a record with no PODMAN_SYSTEMD_UNIT label (ad-hoc container)', () => {
    const adhoc = { Id: 'x', Names: ['/my-adhoc'], State: 'exited', Labels: {} };
    expect(isOrphanedContainerRecord(adhoc, false)).toBe(false);
  });

  it('treats unknown/transient states conservatively as running (keep)', () => {
    const stopping = { ...ghost, State: 'stopping' };
    expect(isOrphanedContainerRecord(stopping, false)).toBe(false);
  });

  it.each(['exited', 'stopped', 'created', 'dead'])(
    'reconciles a dead-state (%s) record whose unit is gone',
    state => {
      expect(isOrphanedContainerRecord({ ...ghost, State: state }, false)).toBe(true);
    },
  );
});

describe('containerDisplayName', () => {
  it('strips the leading slash off the first name', () => {
    expect(containerDisplayName({ Id: 'deadbeefcafe00', Names: ['/hermes-hermes'] })).toBe('hermes-hermes');
  });
  it('falls back to a short id when unnamed', () => {
    expect(containerDisplayName({ Id: 'deadbeefcafe0011' })).toBe('deadbeefcafe');
  });
});

// --- The end-to-end reconcile pass ---
describe('reconcileOrphanContainers', () => {
  function systemctlShow(loadState: string, fragmentPath: string) {
    return { stdout: `LoadState=${loadState}\nFragmentPath=${fragmentPath}\n`, stderr: '' };
  }

  it('removes the exited ghost whose unit is gone, keeps the running one', async () => {
    const records: ContainerRecord[] = [
      // ghost: exited, unit gone
      { Id: 'ghost1', Names: ['/hermes-hermes'], State: 'exited', Labels: { PODMAN_SYSTEMD_UNIT: 'hermes.service' } },
      // current hermes: running, unit present — must survive
      { Id: 'live1', Names: ['/hermes-hermes-new'], State: 'running', Labels: { PODMAN_SYSTEMD_UNIT: 'hermes.service' } },
    ];
    mockGetPodmanPs.mockResolvedValue(records);
    mockExecutor.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'systemctl') return systemctlShow('not-found', '');
      if (argv[0] === 'podman' && argv[1] === 'rm') return { stdout: '', stderr: '' };
      throw new Error(`unexpected execArgv: ${argv.join(' ')}`);
    });

    const result = await reconcileOrphanContainers();

    expect(result.removed).toEqual(['hermes-hermes']);
    expect(result.failed).toEqual([]);
    // only the exited record is even inspected (running is skipped)
    expect(result.inspected).toBe(1);
    // podman rm called exactly once, on the ghost id
    const rmCalls = mockExecutor.execArgv.mock.calls.filter(c => c[0][0] === 'podman');
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0][0]).toEqual(['podman', 'rm', '-f', 'ghost1']);
  });

  it('keeps an exited record whose managing unit IS still present', async () => {
    mockGetPodmanPs.mockResolvedValue([
      { Id: 'kept1', Names: ['/immich-server'], State: 'exited', Labels: { PODMAN_SYSTEMD_UNIT: 'immich.service' } },
    ]);
    mockExecutor.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'systemctl') {
        return systemctlShow('loaded', '/home/core/.config/containers/systemd/immich.service');
      }
      throw new Error(`unexpected execArgv: ${argv.join(' ')}`);
    });

    const result = await reconcileOrphanContainers();

    expect(result.removed).toEqual([]);
    expect(result.inspected).toBe(1);
    // no podman rm issued
    expect(mockExecutor.execArgv.mock.calls.some(c => c[0][0] === 'podman')).toBe(false);
  });

  it('fails SAFE: keeps the container when the unit probe errors', async () => {
    mockGetPodmanPs.mockResolvedValue([
      { Id: 'maybe1', Names: ['/mystery'], State: 'exited', Labels: { PODMAN_SYSTEMD_UNIT: 'mystery.service' } },
    ]);
    mockExecutor.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'systemctl') throw new Error('dbus unavailable');
      throw new Error(`unexpected execArgv: ${argv.join(' ')}`);
    });

    const result = await reconcileOrphanContainers();

    expect(result.removed).toEqual([]);
    expect(mockExecutor.execArgv.mock.calls.some(c => c[0][0] === 'podman')).toBe(false);
  });

  it('records a removal failure without throwing', async () => {
    mockGetPodmanPs.mockResolvedValue([
      { Id: 'ghost2', Names: ['/old-stack'], State: 'exited', Labels: { PODMAN_SYSTEMD_UNIT: 'old.service' } },
    ]);
    mockExecutor.execArgv.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'systemctl') return systemctlShow('not-found', '');
      if (argv[0] === 'podman') throw new Error('container in use');
      throw new Error(`unexpected execArgv: ${argv.join(' ')}`);
    });

    const result = await reconcileOrphanContainers();

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ name: 'old-stack', error: 'container in use' }]);
  });

  it('returns empty when podman ps fails (no throw)', async () => {
    mockGetPodmanPs.mockRejectedValue(new Error('podman down'));
    const result = await reconcileOrphanContainers();
    expect(result).toEqual({ removed: [], failed: [], inspected: 0 });
  });
});
