/**
 * `POST /api/system/storage` must not report a mount it did not achieve (#2626).
 *
 * The route used to answer `{ mounted: true, persistent: true }` whenever
 * `mount` exited 0 — nothing checked that the mountpoint was afterwards
 * actually backed by the array, and the exit codes of the three steps that
 * write + enable the boot units were discarded. A box that answered "success"
 * could be one where the mount silently did not take, and every service
 * installed after it wrote its data to the boot disk.
 *
 * The reproduction here is the real box's shape: `/var/mnt/data` on
 * `/dev/md127` (a degraded raid1) with `/var` on a much smaller NVMe
 * partition, so a swallowed mount failure means the data lands on the wrong
 * disk *and* in a fraction of the space.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mountVerdict, summarisePersistence } from '@/lib/storage/mountOutcome';

interface ExecResult { code: number; stdout: string; stderr: string }

/** Command substring → result. First match wins; default is a clean exit. */
const script: Array<{ match: string; result: ExecResult }> = [];
const commands: string[] = [];

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

vi.mock('@/lib/agent/manager', () => ({
  agentManager: {
    ensureAgent: vi.fn(async () => ({
      sendCommand: vi.fn(async (_kind: string, { command }: { command: string }) => {
        commands.push(command);
        const hit = script.find(s => command.includes(s.match));
        return hit ? hit.result : ok();
      }),
    })),
  },
}));

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));

import { POST } from '@/app/api/system/storage/route';

const mount = async () => {
  const res = await POST(new NextRequest('http://test/api/system/storage?node=Local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device: '/dev/md127', mountpoint: '/var/mnt/data', label: 'data', fstype: 'xfs',
    }),
  }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  script.length = 0;
  commands.length = 0;
});

describe('POST /api/system/storage — the mount is verified, not assumed', () => {
  it('reports mounted + persistent when every step really succeeded', async () => {
    script.push({ match: 'findmnt', result: ok('/dev/md127\n') });

    const { status, body } = await mount();

    expect(status).toBe(200);
    expect(body.mounted).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.persistent).toBe(true);
    expect(body.incomplete).toEqual([]);
    // It actually looked: a verification command was issued.
    expect(commands.some(c => c.includes('findmnt') && c.includes('/var/mnt/data'))).toBe(true);
  });

  it('fails when mount itself exits non-zero', async () => {
    script.push({ match: 'sudo mount', result: { code: 32, stdout: '', stderr: 'mount: wrong fs type' } });
    script.push({ match: 'findmnt', result: ok('/dev/nvme1n1p4\n') });

    const { status, body } = await mount();

    expect(status).toBe(500);
    expect(body.mounted).toBe(false);
    expect(body.error).toMatch(/wrong fs type/);
  });

  // The regression this issue is about: `mount` returns 0, but the mountpoint
  // is still the boot disk. Pre-fix this answered 200 + mounted:true.
  it('fails when mount exits 0 but the mountpoint is still the boot disk', async () => {
    script.push({ match: 'findmnt', result: ok('/dev/nvme1n1p4\n') });

    const { status, body } = await mount();

    expect(status).toBe(500);
    expect(body.mounted).toBe(false);
    expect(body.error).toContain('/dev/nvme1n1p4');
    expect(body.error).toContain('/dev/md127');
  });

  it('fails when the mount cannot be verified at all', async () => {
    script.push({ match: 'findmnt', result: { code: 1, stdout: '', stderr: '' } });

    const { status, body } = await mount();

    expect(status).toBe(500);
    expect(body.mounted).toBe(false);
    expect(body.error).toMatch(/could not be verified/);
  });

  // A live mount whose boot units did not get written is its own state: the
  // data does land on the array now, so the install may go on, but the report
  // must say what did not happen instead of claiming persistence.
  it('reports mounted-but-not-persistent when a boot-unit step fails', async () => {
    script.push({ match: 'findmnt', result: ok('/dev/md127\n') });
    script.push({ match: 'systemctl daemon-reload', result: { code: 1, stdout: '', stderr: 'Failed to enable unit' } });

    const { status, body } = await mount();

    expect(status).toBe(200);
    expect(body.mounted).toBe(true);
    expect(body.persistent).toBe(false);
    expect(body.incomplete).toEqual(['enable the boot units']);
    expect(body.summary).toContain('3/4');
    expect(body.summary).toContain('NOT done');
  });

  it('accepts a by-label source for the same array', async () => {
    script.push({ match: 'findmnt', result: ok('/dev/disk/by-label/data\n') });

    const { status, body } = await mount();

    expect(status).toBe(200);
    expect(body.mounted).toBe(true);
  });
});

describe('mountVerdict', () => {
  const base = { mountCode: 0, findmntCode: 0, findmntSource: '/dev/md127', device: '/dev/md127' };

  it('passes when the mountpoint is backed by the requested device', () => {
    expect(mountVerdict(base)).toEqual({ ok: true });
  });

  it('tolerates a btrfs subvolume suffix and trailing whitespace', () => {
    expect(mountVerdict({ ...base, findmntSource: '  /dev/md127[/@]  \n' })).toEqual({ ok: true });
  });

  it('treats an empty findmnt answer as failure, not as success', () => {
    const v = mountVerdict({ ...base, findmntSource: '' });
    expect(v.ok).toBe(false);
  });

  it('rejects a different source device', () => {
    const v = mountVerdict({ ...base, findmntSource: '/dev/nvme1n1p4' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('did not take');
  });
});

describe('summarisePersistence', () => {
  it('is denominator-first when everything ran', () => {
    const out = summarisePersistence([{ name: 'a', code: 0 }, { name: 'b', code: 0 }]);
    expect(out).toMatchObject({ persistent: true, incomplete: [] });
    expect(out.summary).toContain('2/2');
  });

  it('names what did not happen', () => {
    const out = summarisePersistence([
      { name: 'write the mount unit', code: 1, stderr: 'read-only file system' },
      { name: 'enable the boot units', code: 0 },
    ]);
    expect(out.persistent).toBe(false);
    expect(out.incomplete).toEqual(['write the mount unit']);
    expect(out.summary).toContain('1/2');
    expect(out.summary).toContain('write the mount unit');
    expect(out.summary).toContain('read-only file system');
  });
});
