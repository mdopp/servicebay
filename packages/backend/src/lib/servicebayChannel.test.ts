/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[][] = [];
const execMock = vi.fn(async (argv: string[]) => {
  calls.push(argv);
  if (argv.includes('inspect')) return { stdout: 'ghcr.io/mdopp/servicebay:dev\n', stderr: '' };
  return { stdout: '', stderr: '' };
});

vi.mock('@/lib/executor', () => ({ getExecutor: () => ({ execArgv: (a: string[]) => execMock(a) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { getServicebayChannel, setServicebayChannel, isChannel } from './servicebayChannel';

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { calls.length = 0; execMock.mockClear(); });

describe('servicebayChannel', () => {
  it('validates channels', () => {
    expect(isChannel('latest')).toBe(true);
    expect(isChannel('dev')).toBe(true);
    expect(isChannel('test')).toBe(true);
    expect(isChannel('nightly')).toBe(false);
  });

  it('reads the running channel from the quadlet image tag', async () => {
    expect(await getServicebayChannel()).toBe('dev');
  });

  it('re-points the quadlet tag (channel as $1, not interpolated), then pulls + reloads + restarts', async () => {
    await setServicebayChannel('dev');
    await flush(); // let the detached pull/restart run
    const flat = calls.map(c => c.join(' '));
    const sed = calls.find(c => c.join(' ').includes('sed'));
    expect(sed?.includes('dev')).toBe(true); // channel passed as a positional arg
    expect(flat.some(c => c.includes('podman pull') && c.includes('servicebay:dev'))).toBe(true);
    expect(flat.some(c => c.includes('daemon-reload'))).toBe(true);
    expect(flat.some(c => c.includes('restart --no-block servicebay.service'))).toBe(true);
  });

  it('refuses an unknown channel before touching the box', async () => {
    await expect(setServicebayChannel('prod' as any)).rejects.toThrow(/Unknown channel/);
    expect(calls).toHaveLength(0);
  });
});
