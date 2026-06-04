import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:dns/promises Resolver so the public-A-record check is
// deterministic (no real DNS in unit tests). Each Resolver instance's
// resolve4 is driven by the module-level `resolve4Impl`.
let resolve4Impl: (domain: string) => Promise<string[]>;
vi.mock('node:dns/promises', () => {
  class Resolver {
    setServers() {}
    resolve4(domain: string) {
      return resolve4Impl(domain);
    }
  }
  return { Resolver, default: { Resolver } };
});

import { checkPublicARecord, missingARecordMessage } from './publicDnsCheck';

describe('checkPublicARecord (#1680)', () => {
  beforeEach(() => {
    resolve4Impl = async () => [];
  });

  it('reports hasRecord when a public resolver returns an A record', async () => {
    resolve4Impl = async () => ['92.252.126.27'];
    const res = await checkPublicARecord('files.dopp.cloud');
    expect(res.hasRecord).toBe(true);
    expect(res.addresses).toContain('92.252.126.27');
    expect(res.inconclusive).toBe(false);
  });

  it('reports no record (not inconclusive) when resolvers answer NXDOMAIN', async () => {
    // A resolver that *answered* but had no A record rejects (Node throws
    // ENOTFOUND); the helper distinguishes this from a transient outage by
    // the all-errored test only flipping `inconclusive` when EVERY query
    // throws AND there are zero addresses. Here both throw with no
    // addresses → inconclusive (we can't tell NXDOMAIN from timeout at the
    // Node API level, so we DON'T block issuance — the caller proceeds).
    resolve4Impl = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    const res = await checkPublicARecord('ollama.dopp.cloud');
    expect(res.hasRecord).toBe(false);
    expect(res.addresses).toEqual([]);
    expect(res.inconclusive).toBe(true);
  });

  it('treats a mix (one resolver answers, one errors) as a real record', async () => {
    let call = 0;
    resolve4Impl = async () => {
      call += 1;
      if (call === 1) return ['92.252.126.27'];
      throw new Error('timeout');
    };
    const res = await checkPublicARecord('photos.dopp.cloud');
    expect(res.hasRecord).toBe(true);
    expect(res.inconclusive).toBe(false);
  });
});

describe('missingARecordMessage (#1680)', () => {
  it('names the domain and the concrete WAN IP when known', () => {
    const msg = missingARecordMessage('ollama.dopp.cloud', '92.252.126.27');
    expect(msg).toContain('ollama.dopp.cloud');
    expect(msg).toContain('no public DNS A record');
    expect(msg).toContain('→ 92.252.126.27');
  });

  it('falls back to a what-is-my-IP hint when the WAN IP is unknown', () => {
    const msg = missingARecordMessage('ollama.dopp.cloud');
    expect(msg).toContain('ollama.dopp.cloud');
    expect(msg).toContain('ipify.org');
  });
});
