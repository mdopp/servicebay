/**
 * #2579 — the LAN resolver used to flatten "the resolver said no such name"
 * and "nothing came back" into the same `null`, and its one caller that
 * reports to a human then told the operator DNS was misconfigured whenever a
 * query was merely dropped. These pin the distinction.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolve4ViaLan, resolve4ViaLanDetailed } from './lanResolver';

const LAN_IP = '192.168.178.100';

/** A resolver factory whose `resolve4` does whatever the test says. */
function factory(resolve4: (h: string) => Promise<string[]>) {
  return () => ({ resolve4: vi.fn(resolve4) });
}

function withCode(code: string): Promise<never> {
  return Promise.reject(Object.assign(new Error(code), { code }));
}

describe('resolve4ViaLanDetailed', () => {
  it('binds to AdGuard on loopback first, then the box LAN IP', async () => {
    const seen: string[][] = [];
    await resolve4ViaLanDetailed('auth.dopp.cloud', LAN_IP, servers => {
      seen.push(servers);
      return { resolve4: async () => [LAN_IP] };
    });
    expect(seen).toEqual([['127.0.0.1', LAN_IP]]);
  });

  it('ok with the A-records when the resolver answers', async () => {
    const r = await resolve4ViaLanDetailed('auth.dopp.cloud', LAN_IP, factory(async () => [LAN_IP]));
    expect(r).toEqual({ outcome: 'ok', addresses: [LAN_IP] });
  });

  it('NXDOMAIN is a definitive negative answer, not silence', async () => {
    const r = await resolve4ViaLanDetailed('nope.dopp.cloud', LAN_IP, factory(() => withCode('ENOTFOUND')));
    expect(r.outcome).toBe('no-answer');
    expect(r.code).toBe('ENOTFOUND');
  });

  it('an empty A-set is a negative answer too — the resolver did reply', async () => {
    const r = await resolve4ViaLanDetailed('empty.dopp.cloud', LAN_IP, factory(async () => []));
    expect(r.outcome).toBe('no-answer');
    expect(r.addresses).toBeNull();
  });

  it('a timeout is its own outcome — it says nothing about the name', async () => {
    const r = await resolve4ViaLanDetailed('slow.dopp.cloud', LAN_IP, factory(() => withCode('ETIMEOUT')));
    expect(r.outcome).toBe('timeout');
  });

  it('a resolver failure (SERVFAIL / REFUSED) is an error, not a missing name', async () => {
    const r = await resolve4ViaLanDetailed('sf.dopp.cloud', LAN_IP, factory(() => withCode('ESERVFAIL')));
    expect(r.outcome).toBe('error');
    expect(r.code).toBe('ESERVFAIL');
  });

  it('a query that never settles times out rather than hanging the probe', async () => {
    vi.useFakeTimers();
    try {
      const pending = resolve4ViaLanDetailed('hang.dopp.cloud', LAN_IP, factory(() => new Promise<string[]>(() => {})));
      await vi.advanceTimersByTimeAsync(3100);
      await expect(pending).resolves.toMatchObject({ outcome: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolve4ViaLan (the null-returning wrapper single-lookup callers use)', () => {
  it('returns the addresses on success', async () => {
    await expect(resolve4ViaLan('auth.dopp.cloud', LAN_IP, factory(async () => [LAN_IP]))).resolves.toEqual([LAN_IP]);
  });

  it('still collapses every non-answer to null', async () => {
    await expect(resolve4ViaLan('x.dopp.cloud', LAN_IP, factory(() => withCode('ENOTFOUND')))).resolves.toBeNull();
    await expect(resolve4ViaLan('x.dopp.cloud', LAN_IP, factory(() => withCode('ETIMEOUT')))).resolves.toBeNull();
  });
});
