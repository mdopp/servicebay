/**
 * #3028 — the gathering, not the parsing.
 *
 * `hostPorts.test.ts` covers the `ss` parsing and the merge. This covers the
 * part that asks the node, and specifically the one way this would be worse
 * than useless: **a failed read must not come back looking like an empty box.**
 * "Nothing is listening" and "I could not look" are opposite answers, and a
 * caller that acts on the first when the second is true walks straight into the
 * collision this verb exists to prevent.
 *
 * Written before CI asked for it. The last two times I tested the pieces and
 * not the seam, the seam was where the defect lived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ execSafe: vi.fn(), listServices: vi.fn() }));

vi.mock('@/lib/executor', () => ({ getExecutor: () => ({ execSafe: mocks.execSafe }) }));
vi.mock('./serviceListing', () => ({ ServiceListing: { listServices: mocks.listServices } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { readHostPorts } from './hostPortsRun';

const SS_OUTPUT = [
  'tcp   LISTEN 0 4096 0.0.0.0:8096 0.0.0.0:* users:(("conmon",pid=1,fd=5))',
  'tcp   LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=2,fd=3))',
  'tcp   LISTEN 0 128  0.0.0.0:22   0.0.0.0:* users:(("sshd",pid=3,fd=4))',
  'udp   UNCONN 0 0    0.0.0.0:53   0.0.0.0:* users:(("adguard",pid=4,fd=8))',
  '',
].join('\n');

describe('readHostPorts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSafe.mockResolvedValue({ code: 0, stdout: SS_OUTPUT, stderr: '' });
    mocks.listServices.mockResolvedValue([{ name: 'media', ports: [{ host: '8096' }] }]);
  });

  it('asks the node for its listener table and merges the service names in', async () => {
    const r = await readHostPorts('Local');
    expect(mocks.execSafe.mock.calls[0][0]).toEqual(['ss', '-tulpnH']);
    expect(r.ports.find(p => p.port === 8096)).toMatchObject({ owner: 'media', kind: 'service' });
    expect(r.ports.find(p => p.port === 22)).toMatchObject({ owner: 'sshd', kind: 'other' });
    expect(r.ports.find(p => p.port === 3000)?.kind).toBe('control-plane');
  });

  it('does NOT ask for sudo — a nicer process name is not worth a privilege', async () => {
    await readHostPorts('Local');
    const opts = mocks.execSafe.mock.calls[0][1] as { sudo?: boolean; check?: boolean };
    expect(opts.sudo).toBeUndefined();
    // …and it reads the exit code rather than letting a non-zero throw.
    expect(opts.check).toBe(false);
  });

  it('a failed `ss` comes back EMPTY AND SAYS SO — not as an empty box', async () => {
    // The whole hazard. Acting on "nothing is listening" when the truth is
    // "I could not look" is the collision this verb exists to prevent.
    mocks.execSafe.mockResolvedValue({ code: 1, stdout: '', stderr: 'ss: command not found' });
    const r = await readHostPorts('Local');
    expect(r.ports).toEqual([]);
    expect(r.summary).toContain('Do not read an empty list');
    expect(r.free).toEqual([]);
  });

  it('an executor that throws does not take the call with it', async () => {
    mocks.execSafe.mockRejectedValue(new Error('node unreachable'));
    const r = await readHostPorts('Local');
    expect(r.ports).toEqual([]);
    expect(r.summary).toContain('Do not read an empty list');
  });

  it('a service list that throws still yields the listener table', async () => {
    // Half an answer is worth having: the ports are still taken, they just
    // carry process names instead of service names.
    mocks.listServices.mockRejectedValue(new Error('store not ready'));
    const r = await readHostPorts('Local');
    expect(r.ports.find(p => p.port === 8096)).toMatchObject({ owner: 'conmon', kind: 'other' });
    expect(r.ports.length).toBeGreaterThan(0);
  });

  it('skips lines it cannot read rather than inventing ports', async () => {
    mocks.execSafe.mockResolvedValue({
      code: 0,
      stdout: `Netid State Recv-Q Send-Q Local Peer\n${SS_OUTPUT}\nnonsense\n`,
      stderr: '',
    });
    const r = await readHostPorts('Local');
    expect(r.ports.map(p => p.port).sort((a, b) => a - b)).toEqual([22, 53, 3000, 8096]);
  });

  it('suggests only ports nothing holds', async () => {
    mocks.listServices.mockResolvedValue([{ name: 'x', ports: [{ host: 8090 }] }]);
    const r = await readHostPorts('Local');
    expect(r.free).not.toContain(8090);
    expect(r.free.length).toBeGreaterThan(0);
  });
});
