/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockConfig: any = {};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(mockConfig)),
  saveConfig: vi.fn((cfg: any) => {
    mockConfig = cfg;
    return Promise.resolve();
  }),
}));

import {
  recordHandlerFailure,
  clearHandlerFailure,
  listHandlerFailures,
  handlerFailureKey,
  emitFeatureInstalledWithRetry,
  MAX_EMIT_ATTEMPTS,
} from './handlerFailures';
import type { EmitResult } from '@/lib/capabilities/bus';

beforeEach(() => {
  mockConfig = {};
});

const ok: EmitResult = { ok: true, results: [], failures: [] };
const retryableFail = (msg = 'boom'): EmitResult => ({
  ok: false,
  results: [{ handler: 'authelia.oidc', result: { ok: false, retryable: true, message: msg } }],
  failures: [{ handler: 'authelia.oidc', result: { ok: false, retryable: true, message: msg } }],
});
const nonRetryableFail = (): EmitResult => ({
  ok: false,
  results: [{ handler: 'nginx.proxy', result: { ok: false, retryable: false, message: 'nope' } }],
  failures: [{ handler: 'nginx.proxy', result: { ok: false, retryable: false, message: 'nope' } }],
});

describe('emitFeatureInstalledWithRetry (#2160)', () => {
  it('a handler that fails-then-succeeds is retried and ends green', async () => {
    const emit = vi
      .fn<[], Promise<EmitResult>>()
      .mockResolvedValueOnce(retryableFail())
      .mockResolvedValueOnce(ok);
    const result = await emitFeatureInstalledWithRetry({ emit, sleep: async () => {} });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('a handler that always fails exhausts the retry budget and stays failed', async () => {
    const emit = vi.fn<[], Promise<EmitResult>>().mockResolvedValue(retryableFail());
    const onRetry = vi.fn();
    const result = await emitFeatureInstalledWithRetry({ emit, onRetry, sleep: async () => {} });
    expect(emit).toHaveBeenCalledTimes(MAX_EMIT_ATTEMPTS);
    expect(onRetry).toHaveBeenCalledTimes(MAX_EMIT_ATTEMPTS - 1);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  it('does not retry a non-retryable failure', async () => {
    const emit = vi.fn<[], Promise<EmitResult>>().mockResolvedValue(nonRetryableFail());
    const result = await emitFeatureInstalledWithRetry({ emit, sleep: async () => {} });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});

describe('handler failure store (#2160/#2161)', () => {
  it('records, lists, and clears a failure keyed by kind+service', async () => {
    await recordHandlerFailure({ kind: 'capability', service: 'immich', message: 'authelia.oidc: HTTP 500' });
    await recordHandlerFailure({ kind: 'restore', service: 'radicale', message: 'NAS unreachable' });

    let all = await listHandlerFailures();
    expect(all).toHaveLength(2);
    expect(mockConfig.installHandlerFailures[handlerFailureKey('capability', 'immich')].message).toContain('authelia.oidc');

    const cleared = await clearHandlerFailure('capability', 'immich');
    expect(cleared).toBe(true);
    all = await listHandlerFailures();
    expect(all).toHaveLength(1);
    expect(all[0].service).toBe('radicale');
  });

  it('clearing a non-existent record returns false', async () => {
    expect(await clearHandlerFailure('restore', 'nope')).toBe(false);
  });

  it('re-recording the same service overwrites (idempotent key)', async () => {
    await recordHandlerFailure({ kind: 'restore', service: 'radicale', message: 'first' });
    await recordHandlerFailure({ kind: 'restore', service: 'radicale', message: 'second' });
    const all = await listHandlerFailures();
    expect(all).toHaveLength(1);
    expect(all[0].message).toBe('second');
  });
});
