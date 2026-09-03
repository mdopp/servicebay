/**
 * The shared phase plumbing (#2742): the job log, the job patch, the abort
 * flag, the loopback fetch and the standing-warning append.
 *
 * Every phase reaches through this module, so the contracts asserted here —
 * "a log line lands on disk AND on the socket", "a patch that wrote emits,
 * one that didn't stays quiet", "the loopback fetch always carries the
 * internal token" — are the ones a phase test is entitled to assume.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobState } from '../jobStore';

const appendLogMock = vi.fn<(id: string, line: string) => Promise<void>>();
const updateJobMock = vi.fn<(id: string, patch: Partial<JobState>) => Promise<JobState | null>>();
const getJobMock = vi.fn<(id: string) => Promise<JobState | null>>();
vi.mock('../jobStore', () => ({
  appendLog: (id: string, line: string) => appendLogMock(id, line),
  updateJob: (id: string, patch: Partial<JobState>) => updateJobMock(id, patch),
  getJob: (id: string) => getJobMock(id),
}));

const emitJobLogMock = vi.fn<(id: string, line: string) => void>();
const emitJobUpdateMock = vi.fn<(state: JobState) => void>();
vi.mock('../socketBridge', () => ({
  emitJobLog: (id: string, line: string) => emitJobLogMock(id, line),
  emitJobUpdate: (state: JobState) => emitJobUpdateMock(state),
}));

vi.mock('@/lib/auth/internalToken', () => ({ getInternalApiToken: () => 'internal-token-abc' }));

import {
  apiFetch,
  appendJobWarning,
  clearJobAbortFlag,
  humanBytes,
  isJobAborted,
  log,
  markJobAborted,
  patchJob,
} from './context';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => {
  appendLogMock.mockReset().mockResolvedValue(undefined);
  updateJobMock.mockReset().mockResolvedValue(null);
  getJobMock.mockReset().mockResolvedValue(null);
  emitJobLogMock.mockReset();
  emitJobUpdateMock.mockReset();
  fetchSpy.mockReset();
  clearJobAbortFlag('job1');
  clearJobAbortFlag('job2');
});

afterEach(() => {
  delete process.env.PORT;
});

describe('humanBytes', () => {
  it('picks the unit podman reports in — powers of 1024', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(humanBytes(Math.round(1.5 * 1024 * 1024 * 1024))).toBe('1.5 GB');
  });

  it('switches unit exactly at the 1024 boundary, not at 1000', () => {
    expect(humanBytes(1023)).toBe('1023 B');
    expect(humanBytes(1024)).toBe('1 KB');
  });
});

describe('the per-job abort flag', () => {
  it('is false until abortJob raises it, and is scoped to one job', () => {
    expect(isJobAborted('job1')).toBe(false);
    markJobAborted('job1');
    expect(isJobAborted('job1')).toBe(true);
    // A second install running concurrently must not see job1's abort.
    expect(isJobAborted('job2')).toBe(false);
  });

  it('is dropped again by clearJobAbortFlag — a re-run of the same id starts clean', () => {
    markJobAborted('job1');
    clearJobAbortFlag('job1');
    expect(isJobAborted('job1')).toBe(false);
  });
});

describe('log', () => {
  it('persists to the job log AND pushes over the socket', async () => {
    await log('job1', 'Installing nginx...');
    expect(appendLogMock).toHaveBeenCalledWith('job1', 'Installing nginx...');
    expect(emitJobLogMock).toHaveBeenCalledWith('job1', 'Installing nginx...');
  });

  it('writes to disk before it emits — the file is the source of truth on reattach', async () => {
    const order: string[] = [];
    appendLogMock.mockImplementation(async () => { order.push('append'); });
    emitJobLogMock.mockImplementation(() => { order.push('emit'); });
    await log('job1', 'line');
    expect(order).toEqual(['append', 'emit']);
  });
});

describe('patchJob', () => {
  it('broadcasts the new state and returns it', async () => {
    const next = { id: 'job1', phase: 'running' } as JobState;
    updateJobMock.mockResolvedValue(next);
    await expect(patchJob('job1', { phase: 'running' })).resolves.toBe(next);
    expect(emitJobUpdateMock).toHaveBeenCalledWith(next);
  });

  it('emits nothing when the job no longer exists', async () => {
    updateJobMock.mockResolvedValue(null);
    await expect(patchJob('gone', { phase: 'done' })).resolves.toBeNull();
    expect(emitJobUpdateMock).not.toHaveBeenCalled();
  });
});

describe('appendJobWarning (#2160/#2161)', () => {
  it('appends to the existing warnings rather than replacing them', async () => {
    getJobMock.mockResolvedValue({ warnings: ['media: first'] } as JobState);
    await appendJobWarning('job1', 'auth: second');
    expect(updateJobMock).toHaveBeenCalledWith('job1', { warnings: ['media: first', 'auth: second'] });
  });

  it('starts the array when the job carries no warnings yet', async () => {
    getJobMock.mockResolvedValue({} as JobState);
    await appendJobWarning('job1', 'only');
    expect(updateJobMock).toHaveBeenCalledWith('job1', { warnings: ['only'] });
  });

  it('never throws — an unreadable job or a failed write must not kill the run', async () => {
    getJobMock.mockRejectedValue(new Error('state file vanished'));
    updateJobMock.mockRejectedValue(new Error('locked'));
    await expect(appendJobWarning('job1', 'w')).resolves.toBeUndefined();
    // Still attempted the write with the warning it could not read a base for.
    expect(updateJobMock).toHaveBeenCalledWith('job1', { warnings: ['w'] });
  });
});

describe('apiFetch — the loopback call every phase makes', () => {
  it('targets 127.0.0.1 on $PORT and attaches the internal token', async () => {
    process.env.PORT = '4123';
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/api/services?stream=1', { method: 'POST' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4123/api/services?stream=1');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('x-sb-internal-token')).toBe('internal-token-abc');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('defaults to port 3000 when PORT is unset', async () => {
    delete process.env.PORT;
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/api/install/status');
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:3000/api/install/status');
  });

  it('leaves a caller-supplied token header alone', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/api/x', { headers: { 'x-sb-internal-token': 'caller-supplied' } });
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('x-sb-internal-token')).toBe('caller-supplied');
  });
});
