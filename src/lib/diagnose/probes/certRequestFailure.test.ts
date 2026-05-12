/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  config: {} as any,
  services: [] as any[],
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
});

// ─── Probe top-level ────────────────────────────────────────────────────

describe('checkCertRequestFailure', () => {
  function mockTail(stdout: string, code = 0) {
    mockAgent.sendCommand.mockResolvedValueOnce({ code, stdout, stderr: '' });
  }

  it('returns info when the log tail is empty', async () => {
    mockTail('');
    const out = await checkCertRequestFailure('Local');
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/hasn't attempted/);
  });

  it('returns ok when tail has no failure markers', async () => {
    mockTail('2026-05-12 00:00:00,000:INFO:certbot:All clean.');
    const out = await checkCertRequestFailure('Local');
    expect(out.status).toBe('ok');
  });

  it('returns fail with one item per failed domain', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    mockTail(`${recent},123:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   connection
  Detail: 1.2.3.4: Fetching http://vault.dopp.cloud/.well-known/acme-challenge/abc: Connection refused`);
    const out = await checkCertRequestFailure('Local');
    expect(out.status).toBe('fail');
    expect(out.items).toHaveLength(1);
    expect(out.items?.[0].label).toBe('vault.dopp.cloud');
    expect(out.items?.[0].detail).toMatch(/Connection refused/);
    expect(out.items?.[0].actionIds).toEqual(['show_log_tail', 'retry_request']);
  });

  it('returns ok when the failure is older than the freshness window', async () => {
    // 48h old → outside the 24h freshness window.
    const old = new Date(Date.now() - 48 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    mockTail(`${old},000:ERROR:certbot:Some challenges have failed.
  Domain: vault.dopp.cloud
  Type:   connection
  Detail: stale failure`);
    const out = await checkCertRequestFailure('Local');
    expect(out.status).toBe('ok');
    expect(out.detail).toMatch(/outside the .* freshness window/);
  });

  it('surfaces a rate-limit pseudo-item when no per-domain block', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    mockTail(`${recent},000:ERROR:certbot:Some challenges have failed.
acme.errors.Error: urn:ietf:params:acme:error:rateLimited :: too many failed authorizations recently`);
    const out = await checkCertRequestFailure('Local');
    expect(out.status).toBe('fail');
    expect(out.items?.[0].label).toMatch(/rate limit/i);
  });

  it('returns info when reading the log fails (non-zero exit)', async () => {
    mockTail('', 1);
    const out = await checkCertRequestFailure('Local');
    expect(out.status).toBe('info');
  });
});

// ─── Action: show_log_tail ──────────────────────────────────────────────

describe('cert_request_failure.show_log_tail', () => {
  it('returns the last 80 lines of the log in details', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: lines, stderr: '' });
    const result = await dispatchProbeAction({
      probeId: 'cert_request_failure',
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
      probeId: 'cert_request_failure',
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
      probeId: 'cert_request_failure',
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
      probeId: 'cert_request_failure',
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
      probeId: 'cert_request_failure',
      actionId: 'retry_request',
      itemId: 'vault.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No NPM certificate exists/);
  });
});
