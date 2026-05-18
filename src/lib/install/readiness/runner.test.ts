import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the probe execution surface so the runner tests don't open real sockets.
const probeAttemptResults: Array<'ok' | 'fail' | 'config-error'> = [];
vi.mock('./probes', () => ({
  runProbe: vi.fn(async () => {
    const next = probeAttemptResults.shift() ?? 'ok';
    if (next === 'ok') return { ok: true, reason: null, detail: 'ok' };
    if (next === 'config-error') return { ok: false, reason: 'config-error', detail: 'bad config' };
    return { ok: false, reason: 'network-error', detail: 'connection refused' };
  }),
}));

import { waitForReadiness } from './runner';

beforeEach(() => {
  probeAttemptResults.length = 0;
});

describe('waitForReadiness', () => {
  it('returns ok when every probe succeeds on first attempt', async () => {
    probeAttemptResults.push('ok', 'ok');
    const logs: string[] = [];
    const r = await waitForReadiness({
      readinessRaw: `
- kind: tcp
  host: x
  port: 1
  timeout: 30s
- kind: tcp
  host: y
  port: 2
  timeout: 30s
`,
      podName: 'demo',
      onLog: (l) => logs.push(l),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.every(x => x.ok)).toBe(true);
    expect(logs.some(l => /Waiting for demo/.test(l))).toBe(true);
    expect(logs.some(l => /✅ demo ready/.test(l))).toBe(true);
  });

  it('returns structured failure when a probe exhausts its deadline', async () => {
    // Push enough 'fail' results to outlast a sub-second timeout.
    for (let i = 0; i < 10; i++) probeAttemptResults.push('fail');
    const r = await waitForReadiness({
      readinessRaw: `
- kind: tcp
  host: x
  port: 1
  timeout: 100ms
`,
      podName: 'slow',
      onLog: () => undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.results[0].ok).toBe(false);
    if (r.results[0].ok) return;
    expect(r.results[0].reason).toBe('network-error');
    expect(r.results[0].message).toMatch(/connection refused/);
  });

  it('config-error reasons fail fast without exhausting the timeout', async () => {
    probeAttemptResults.push('config-error');
    const t0 = Date.now();
    const r = await waitForReadiness({
      readinessRaw: `
- kind: tcp
  host: x
  port: 1
  timeout: 30s
`,
      podName: 'bad',
      onLog: () => undefined,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    if (r.results[0].ok) return;
    expect(r.results[0].reason).toBe('config-error');
  });

  it('surfaces parser failures as a non-ok result with parseErrors', async () => {
    const r = await waitForReadiness({
      readinessRaw: `- kind: bogus\n  timeout: 30s\n`,
      podName: 'broken',
      onLog: () => undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parseErrors?.[0]).toMatch(/unknown.*kind/i);
  });

  it('returns ok with empty results when readinessRaw has no probes (empty list)', async () => {
    const r = await waitForReadiness({
      readinessRaw: `[]`,
      podName: 'noop',
      onLog: () => undefined,
    });
    // Empty list = parse error per spec; ensure we surface it rather than
    // silently treating it as success.
    expect(r.ok).toBe(false);
  });
});
