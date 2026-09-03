/**
 * Detection half of `cert_expiry` (#2594): which rows get `renew_cert`
 * and which get `delete_orphaned_cert`.
 *
 * Only NPM discovery + auth are mocked. The certificate→proxy-host link
 * under test (`npmAdmin.isCertOrphaned`) stays real, so these cases
 * exercise the actual rule, not a restatement of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/npm/client', () => ({
  resolveNpmAdmin: vi.fn(async () => ({ kind: 'ok' as const, apiUrl: 'http://localhost:81', nodeName: 'Local', nodeIp: '127.0.0.1' })),
  getNpmToken: vi.fn(async () => 'tok'),
}));

import './certExpiry';
import { CERT_EXPIRY_ACTION_IDS } from './certExpiry';
import { getProbe } from './registry';
import type { CheckConfig } from '../types';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY + 60_000).toISOString();

const check = (): CheckConfig => ({
  id: 'cert_expiry',
  name: 'TLS certificate expiry',
  type: 'cert_expiry',
  target: 'Local',
  interval: 3600,
  enabled: true,
  created_at: new Date().toISOString(),
  nodeName: 'Local',
});

interface Payload {
  status: string;
  detail: string;
  hint?: string;
  items?: { id: string; label: string; detail: string; status: string; actionIds: string[] }[];
}

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Wire NPM's two tables. `hosts: null` simulates an unreadable
 *  proxy-host list (HTTP 500). */
function npmReturns(certs: unknown[], hosts: unknown[] | null) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/nginx/certificates')) {
      return { ok: true, json: async () => certs } as unknown as Response;
    }
    if (String(url).includes('/api/nginx/proxy-hosts')) {
      return hosts === null
        ? ({ ok: false, status: 500 } as unknown as Response)
        : ({ ok: true, json: async () => hosts } as unknown as Response);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const cert = (id: number, domain: string, days: number) => ({
  id,
  provider: 'letsencrypt',
  domain_names: [domain],
  expires_on: inDays(days),
});

const run = async (): Promise<Payload> => {
  const probe = getProbe('cert_expiry')!;
  const res = (await probe.run(check(), { executor: {} as never })) as { status: string; payload: Payload };
  return res.payload;
};

const runRaw = async () => {
  const probe = getProbe('cert_expiry')!;
  return (await probe.run(check(), { executor: {} as never })) as { status: string; payload: Payload };
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('cert_expiry orphan vs renewable (#2594)', () => {
  it('keeps renew_cert for a cert a proxy host binds by certificate_id — unchanged behaviour', async () => {
    npmReturns(
      [cert(7, 'vault.example.com', 6)],
      [{ id: 1, certificate_id: 7, domain_names: ['vault.example.com'] }],
    );
    const p = await run();
    expect(p.items).toHaveLength(1);
    expect(p.items![0]).toMatchObject({
      id: '7',
      label: 'vault.example.com',
      status: 'warn',
      actionIds: [CERT_EXPIRY_ACTION_IDS.renew],
    });
    expect(p.detail).toBe("1 of 1 Let's Encrypt cert expiring within 14 days.");
    expect(p.hint).not.toMatch(/no proxy host/);
  });

  it('keeps renew_cert when the domain is served, even if the binding host picked a different cert row', async () => {
    // Duplicate cert for a live domain: still not "belongs to nothing".
    npmReturns(
      [cert(9, 'vault.example.com', 3)],
      [{ id: 1, certificate_id: 42, domain_names: ['vault.example.com'] }],
    );
    const p = await run();
    expect(p.items![0].actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.renew]);
  });

  it('keeps renew_cert for a wildcard cert while any host under it is served', async () => {
    npmReturns(
      [cert(11, '*.example.com', 5)],
      [{ id: 1, certificate_id: 42, domain_names: ['vault.example.com'] }],
    );
    const p = await run();
    expect(p.items![0].actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.renew]);
  });

  it('offers delete_orphaned_cert instead of renew_cert for a near-expiry cert no host uses', async () => {
    // The live bug: books.dopp.cloud has no proxy host left.
    npmReturns(
      [cert(11, 'books.example.com', 2), cert(7, 'vault.example.com', 6)],
      [{ id: 1, certificate_id: 7, domain_names: ['vault.example.com'] }],
    );
    const p = await run();
    const orphan = p.items!.find(i => i.id === '11')!;
    expect(orphan.actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.deleteOrphaned]);
    expect(orphan.label).toContain('no proxy host');
    expect(orphan.detail).toMatch(/renewing it would serve nothing/);
    // The still-bound neighbour is untouched.
    expect(p.items!.find(i => i.id === '7')!.actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.renew]);
    expect(p.detail).toMatch(/1 of them belong to no proxy host any more/);
    expect(p.hint).toMatch(/Delete those instead/);
  });

  it('still offers delete_orphaned_cert once the orphan is already expired', async () => {
    npmReturns([cert(11, 'books.example.com', -3)], []);
    const res = await runRaw();
    const item = res.payload.items![0];
    expect(item.actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.deleteOrphaned]);
    // Warn/fail policy deliberately unchanged (#2594 leaves the
    // thresholds alone): expired is still a red item and a red check.
    expect(item.status).toBe('fail');
    expect(res.status).toBe('fail');
    expect(res.payload.status).toBe('fail');
  });

  it('offers NO action at all for an unbound cert that is not near expiry — the pre-provisioned case', async () => {
    // 60 days left: freshly issued ahead of its route. Not listed, so
    // neither renew nor delete is suggested.
    npmReturns([cert(11, 'not-yet.example.com', 60)], []);
    const res = await runRaw();
    expect(res.payload.items).toBeUndefined();
    expect(res.payload.status).toBe('ok');
    expect(res.payload.detail).toMatch(/none expiring in 14 days/);
  });

  it('falls back to renew_cert for every row when the proxy-host list cannot be read', async () => {
    // Fail-closed: "we do not know what is bound" must never read as
    // "nothing is bound" — that would offer to delete live certs.
    npmReturns([cert(11, 'books.example.com', 2)], null);
    const p = await run();
    expect(p.items![0].actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.renew]);
    expect(p.detail).not.toMatch(/no proxy host/);
  });

  it('treats a disabled proxy host as a binding — the route is off, not given up', async () => {
    npmReturns(
      [cert(7, 'vault.example.com', 4)],
      [{ id: 1, enabled: false, certificate_id: 7, domain_names: ['vault.example.com'] }],
    );
    const p = await run();
    expect(p.items![0].actionIds).toEqual([CERT_EXPIRY_ACTION_IDS.renew]);
  });
});
