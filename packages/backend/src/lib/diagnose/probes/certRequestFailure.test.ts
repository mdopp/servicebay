/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const state = {
  config: {} as any,
  services: [] as any[],
  results: new Map<string, CheckResult>(),
  checks: [{ id: 'cert_request_failure' }] as Array<{ id: string }>,
};

const mockAgent = { sendCommand: vi.fn() };

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(() => Promise.resolve(state.services)) },
}));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getLastResult: (id: string) => state.results.get(id) ?? null,
    getChecks: () => state.checks,
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { dispatchProbeAction } from '../actions';
import { checkCertRequestFailure, parseLetsencryptTail } from './certRequestFailure';
import './certRequestFailure';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

beforeEach(() => {
  state.config = {
    reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } },
    templateSettings: { DATA_DIR: '/mnt/data' },
  };
  state.services = ACTIVE_NGINX;
  state.results = new Map();
  state.checks = [{ id: 'cert_request_failure' }];
  mockAgent.sendCommand.mockReset();
  mockFetch.mockReset();
});

// ─── Parser ─────────────────────────────────────────────────────────────

describe('parseLetsencryptTail', () => {
  it('extracts the structured Domain/Type/Detail block', () => {
    const tail = `2026-05-12 00:27:14,123:DEBUG:certbot:Some leading noise
2026-05-12 00:27:14,200:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   connection
  Detail: 1.2.3.4: Fetching http://vault.dopp.cloud/.well-known/acme-challenge/abc: Connection refused
2026-05-12 00:27:14,250:ERROR:certbot:Cleaning up challenges`;
    const out = parseLetsencryptTail(tail);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].domain).toBe('vault.dopp.cloud');
    expect(out.failures[0].type).toBe('connection');
    expect(out.failures[0].detail).toMatch(/Connection refused/);
    expect(out.rateLimited).toBe(false);
    expect(out.ts).toBeGreaterThan(0);
  });

  it('falls back to the inline "Failed authorization procedure" format', () => {
    const tail = `2026-05-12 00:30:00,000:ERROR:certbot:Some challenges have failed.
2026-05-12 00:30:00,000:ERROR:certbot:Failed authorization procedure. vault.dopp.cloud (http-01): urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for vault.dopp.cloud`;
    const out = parseLetsencryptTail(tail);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].domain).toBe('vault.dopp.cloud');
    expect(out.failures[0].type).toBe('http-01');
    expect(out.failures[0].detail).toMatch(/NXDOMAIN/);
  });

  it('detects rate-limit URN even without per-domain block', () => {
    const tail = `2026-05-12 00:35:00,000:ERROR:certbot:Some challenges have failed.
2026-05-12 00:35:00,000:ERROR:certbot:An unexpected error occurred:
acme.errors.Error: urn:ietf:params:acme:error:rateLimited :: Error creating new order :: too many failed authorizations recently`;
    const out = parseLetsencryptTail(tail);
    expect(out.failures).toHaveLength(0);
    expect(out.rateLimited).toBe(true);
  });

  it('returns no failures for a clean tail', () => {
    const tail = `2026-05-12 00:40:00,000:INFO:certbot:Successfully received certificate.
2026-05-12 00:40:00,000:INFO:certbot:Certificate is saved at: /etc/letsencrypt/live/npm-3/fullchain.pem`;
    const out = parseLetsencryptTail(tail);
    expect(out.failures).toHaveLength(0);
    expect(out.rateLimited).toBe(false);
  });

  it('keeps only the failures from the most recent failed run', () => {
    const tail = `2026-05-11 10:00:00,000:ERROR:certbot:Some challenges have failed.
  Domain: old.dopp.cloud
  Type:   connection
  Detail: old failure
2026-05-12 00:27:14,200:INFO:certbot:Successfully received certificate.
2026-05-12 00:30:00,000:ERROR:certbot:Some challenges have failed.
  Domain: new.dopp.cloud
  Type:   connection
  Detail: new failure`;
    const out = parseLetsencryptTail(tail);
    expect(out.failures.map(f => f.domain)).toEqual(['new.dopp.cloud']);
  });

  /**
   * #547 pattern-aware audit — `category` is the labelled fix-path
   * (port-80 firewall / CAA / DNS / rate-limit / …). Locking it in a
   * test means a future regex tweak that drops one of these patterns
   * fails loudly instead of silently downgrading the operator's row
   * to the generic "ACME error" fallback.
   */
  it('classifies the connection-refused detail as port-80', () => {
    const tail = `2026-05-12 00:27:14,200:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   connection
  Detail: 1.2.3.4: Fetching http://vault.dopp.cloud/.well-known/acme-challenge/abc: Connection refused`;
    expect(parseLetsencryptTail(tail).failures[0].category).toBe('port-80');
  });

  it('classifies an NXDOMAIN detail as dns', () => {
    const tail = `2026-05-12 00:30:00,000:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   http-01
  Detail: DNS problem: NXDOMAIN looking up A for vault.dopp.cloud`;
    expect(parseLetsencryptTail(tail).failures[0].category).toBe('dns');
  });

  it('classifies a CAA detail as caa', () => {
    const tail = `2026-05-12 00:30:00,000:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   dns
  Detail: CAA record for dopp.cloud prevents issuance`;
    expect(parseLetsencryptTail(tail).failures[0].category).toBe('caa');
  });

  it('classifies unknown detail text as `other` (catch-all keeps the row visible)', () => {
    const tail = `2026-05-12 00:30:00,000:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   http-01
  Detail: Some new error message we have not pattern-matched yet`;
    expect(parseLetsencryptTail(tail).failures[0].category).toBe('other');
  });
});

// ─── Reader (Phase 3b: thin HealthStore reader) ─────────────────────────

describe('checkCertRequestFailure (reader)', () => {
  it('returns info when HealthStore has no result yet (check exists, first run pending)', async () => {
    const out = await checkCertRequestFailure();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/first run pending/);
  });

  it('reports the missing-prereq state when the le_request_failure check has not been created yet (#664)', async () => {
    state.checks = [];
    const out = await checkCertRequestFailure();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/NPM bootstrap/);
  });

  it('decodes the runner-encoded payload into the probe shape', async () => {
    const payload = {
      status: 'fail',
      detail: '1 domain with recent ACME failure in NPM\'s letsencrypt.log.',
      hint: 'Most common cause is port 80 not reachable.',
      items: [
        {
          id: 'vault.dopp.cloud',
          label: 'vault.dopp.cloud',
          detail: 'ACME connection challenge failed: refused',
          status: 'fail',
          actionIds: ['show_log_tail', 'retry_request'],
        },
      ],
    };
    state.results.set('cert_request_failure', {
      check_id: 'cert_request_failure',
      timestamp: new Date().toISOString(),
      status: 'fail',
      message: `cert_request_failure:${JSON.stringify(payload)}`,
      latency: 100,
    });
    const out = await checkCertRequestFailure();
    expect(out.status).toBe('fail');
    expect(out.detail).toMatch(/1 domain with recent ACME failure/);
    expect(out.items).toHaveLength(1);
    expect(out.items?.[0].label).toBe('vault.dopp.cloud');
  });

  it('surfaces transport-error plaintext as info', async () => {
    state.results.set('cert_request_failure', {
      check_id: 'cert_request_failure',
      timestamp: new Date().toISOString(),
      status: 'fail',
      message: 'cert_request_failure error: agent timeout',
      latency: 100,
    });
    const out = await checkCertRequestFailure();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/Check failed to run.*agent timeout/);
  });
});

// ─── Action: show_log_tail ──────────────────────────────────────────────

describe('cert_request_failure.show_log_tail', () => {
  it('returns the last 80 lines of the log in details', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: lines, stderr: '' });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'show_log_tail',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    const detailsLines = (result.details ?? '').split('\n');
    expect(detailsLines.length).toBe(80);
    expect(detailsLines[detailsLines.length - 1]).toBe('line199');
  });

  it('reports failure when the log read fails', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'show_log_tail',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not read/);
  });
});

// ─── Action: retry_request ──────────────────────────────────────────────

describe('cert_request_failure.retry_request', () => {
  it('rejects empty itemId', async () => {
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'retry_request',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('triggers NPM renew for the matching cert id', async () => {
    mockFetch
      // /api/tokens
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) })
      // /api/nginx/certificates
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { id: 4, domain_names: ['other.dopp.cloud'] },
          { id: 7, domain_names: ['vault.dopp.cloud'] },
        ]),
      })
      // /api/nginx/certificates/7/renew
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'retry_request',
      itemId: 'vault.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockFetch.mock.calls[2][0]).toMatch(/\/api\/nginx\/certificates\/7\/renew/);
  });

  it('reports a clear message when no NPM cert exists for the domain yet', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: 4, domain_names: ['other.dopp.cloud'] }]),
      });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'retry_request',
      itemId: 'vault.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No NPM certificate exists/);
  });
});
