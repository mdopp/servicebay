/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked sibling-probe handlers so dispatch-through-this-probe doesn't
// actually call NPM / AdGuard. The shared-handler claim only holds if
// dispatching `(domain_unreachable, retry_create)` reaches the same
// function object dispatch on `(proxy_route_missing, retry_create)`
// reaches — the mock returns a sentinel so we can verify that.
vi.mock('./proxyRouteMissing', () => ({
  retryCreate: vi.fn(async ({ itemId }: { itemId?: string }) => ({
    ok: true,
    message: `retry_create reached, itemId=${itemId ?? '(none)'}`,
    refresh: true,
  })),
}));

vi.mock('./adguardRewritesMissing', () => ({
  reprovision: vi.fn(async () => ({
    ok: true,
    message: 'reprovision reached',
    refresh: true,
  })),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve({
    reverseProxy: {
      publicDomain: 'example.com',
      lanIp: '192.168.1.10',
      hosts: [],
    },
  })),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/adguard/rewrites', () => ({
  listRewrites: vi.fn(() => Promise.resolve([])),
}));

import { dispatchProbeAction, actionsForProbe } from '../actions';
import './domainUnreachable';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('domain_unreachable.action registration', () => {
  it('registers retry_create, reprovision, and show_public_dns_instructions', () => {
    const actions = actionsForProbe('domain_unreachable');
    const ids = actions.map(a => a.id).sort();
    expect(ids).toEqual(['reprovision', 'retry_create', 'show_public_dns_instructions']);
  });
});

describe('domain_unreachable.retry_create', () => {
  it('dispatches to the shared retryCreate handler from proxyRouteMissing', async () => {
    const result = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'retry_create',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    // Sentinel from the mocked retryCreate proves the call landed on
    // the shared handler with the right itemId — confirms the
    // "fix-button on the failing-domain row" topology works.
    expect(result.message).toContain('retry_create reached');
    expect(result.message).toContain('vault.example.com');
  });
});

describe('domain_unreachable.reprovision', () => {
  it('dispatches to the shared reprovision handler from adguardRewritesMissing', async () => {
    const result = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'reprovision',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('reprovision reached');
  });
});

describe('domain_unreachable.show_public_dns_instructions', () => {
  it('renders the A-record instructions using the configured apex', async () => {
    const result = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'show_public_dns_instructions',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.details).toBeTruthy();
    // Apex comes from config.reverseProxy.publicDomain — the
    // operator's existing setting, not invented from the itemId.
    expect(result.details).toContain('*.example.com');
    // A-record + wildcard advice present.
    expect(result.details).toContain('Type:  A');
    expect(result.details).toContain('wildcard');
  });

  it('falls back to the itemId\'s parent zone when publicDomain is unset', async () => {
    const config = await import('@/lib/config');
    (config.getConfig as any).mockResolvedValueOnce({
      reverseProxy: { lanIp: '192.168.1.10', hosts: [] },
    });
    const result = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'show_public_dns_instructions',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    // Fallback: strip the first label from the itemId to get the
    // apex. `vault.example.com` → `example.com`.
    expect(result.details).toContain('*.example.com');
  });

  it('returns ok=false when itemId is missing', async () => {
    const result = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'show_public_dns_instructions',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No domain supplied/);
  });
});
