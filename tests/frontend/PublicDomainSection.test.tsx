/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PublicDomainSection from '@/app/(dashboard)/settings/_lib/sections/PublicDomainSection';

vi.mock('@/providers/ToastProvider', () => {
  const addToast = vi.fn();
  return { useToast: () => ({ addToast }) };
});

const LAN_MODE = {
  mode: 'lan' as const,
  activeDomain: 'home.arpa',
  publicDomain: null,
  lanDomain: 'home.arpa',
};
const PUBLIC_MODE = {
  mode: 'public' as const,
  activeDomain: 'dopp.cloud',
  publicDomain: 'dopp.cloud',
  lanDomain: 'home.arpa',
};

const PREFLIGHT_READY = {
  publicDomain: 'dopp.cloud',
  ready: true,
  checks: [
    { id: 'dns', label: 'DNS', status: 'pass', detail: 'ok' },
    { id: 'http01', label: 'HTTP-01', status: 'pass', detail: 'ok' },
    { id: 'port-forward', label: 'Port-forward', status: 'pass', detail: 'ok' },
  ],
};
const PREFLIGHT_BLOCKED = {
  publicDomain: 'dopp.cloud',
  ready: false,
  checks: [
    { id: 'dns', label: 'DNS', status: 'fail', detail: 'NoIPAddress: A record missing' },
    { id: 'http01', label: 'HTTP-01', status: 'pass', detail: 'ok' },
    { id: 'port-forward', label: 'Port-forward', status: 'unknown', detail: 'no gateway' },
  ],
};

interface FetchHandler {
  pattern: RegExp;
  responder: (init?: RequestInit) => Promise<Response>;
}

function installFetch(handlers: FetchHandler[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const h of handlers) {
      if (h.pattern.test(url)) return h.responder(init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
}

function jsonRes(body: any, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PublicDomainSection', () => {
  it('renders the idle form in LAN mode', async () => {
    installFetch([{ pattern: /\/api\/system\/mode$/, responder: () => jsonRes(LAN_MODE) }]);
    render(<PublicDomainSection />);
    await waitFor(() => expect(screen.getByText(/Internal-only mode/i)).toBeTruthy());
    expect(screen.getByPlaceholderText('example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check readiness/i })).toBeTruthy();
  });

  it('renders the public-mode body when already on a public domain', async () => {
    installFetch([{ pattern: /\/api\/system\/mode$/, responder: () => jsonRes(PUBLIC_MODE) }]);
    render(<PublicDomainSection />);
    await waitFor(() => expect(screen.getByText(/Public-domain mode/i)).toBeTruthy());
    expect(screen.getByText('dopp.cloud')).toBeTruthy();
  });

  it('shows blocker details when pre-flight reports a fail', async () => {
    installFetch([
      { pattern: /\/api\/system\/mode$/, responder: () => jsonRes(LAN_MODE) },
      { pattern: /\/api\/system\/reverse-proxy\/preflight/, responder: () => jsonRes(PREFLIGHT_BLOCKED) },
    ]);
    render(<PublicDomainSection />);
    await waitFor(() => expect(screen.getByPlaceholderText('example.com')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('example.com'), { target: { value: 'dopp.cloud' } });
    fireEvent.click(screen.getByRole('button', { name: /Check readiness/i }));

    await waitFor(() => expect(screen.getByText(/NoIPAddress/i)).toBeTruthy());
    // Still in pre-flight phase — no confirm banner yet.
    expect(screen.queryByRole('button', { name: /Migrate to/i })).toBeNull();
  });

  it('advances to the confirm phase when pre-flight is ready', async () => {
    installFetch([
      { pattern: /\/api\/system\/mode$/, responder: () => jsonRes(LAN_MODE) },
      { pattern: /\/api\/system\/reverse-proxy\/preflight/, responder: () => jsonRes(PREFLIGHT_READY) },
    ]);
    render(<PublicDomainSection />);
    await waitFor(() => expect(screen.getByPlaceholderText('example.com')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('example.com'), { target: { value: 'dopp.cloud' } });
    fireEvent.click(screen.getByRole('button', { name: /Check readiness/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Migrate to dopp.cloud/i })).toBeTruthy());
    expect(screen.getByText(/log in again/i)).toBeTruthy();
  });

  it('runs a dry-run and surfaces the step list', async () => {
    const dryResult = {
      plan: {
        publicDomain: 'dopp.cloud',
        lanRoot: 'home.arpa',
        warnings: [],
        steps: [
          { kind: 'npm-dual-server-name', hostId: 1, domain: 'vault.home.arpa', skipped: false },
          { kind: 'authelia-config', node: 'Local', skipped: false },
          { kind: 'cert-request', hostId: 1, domain: 'vault.dopp.cloud', skipped: false },
        ],
      },
      applied: false,
      errors: [],
      stepResults: [{ ok: true }, { ok: true }, { ok: true }],
    };
    installFetch([
      { pattern: /\/api\/system\/mode$/, responder: () => jsonRes(LAN_MODE) },
      { pattern: /\/api\/system\/reverse-proxy\/preflight/, responder: () => jsonRes(PREFLIGHT_READY) },
      { pattern: /\/api\/system\/reverse-proxy\/migrate-to-public/, responder: () => jsonRes(dryResult) },
    ]);
    render(<PublicDomainSection />);
    await waitFor(() => expect(screen.getByPlaceholderText('example.com')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('example.com'), { target: { value: 'dopp.cloud' } });
    fireEvent.click(screen.getByRole('button', { name: /Check readiness/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Dry-run first/i })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Dry-run first/i }));
    });

    await waitFor(() => expect(screen.getByText(/3 steps would run/i)).toBeTruthy());
    // Expand the step list.
    fireEvent.click(screen.getByText(/Show step-by-step/i));
    expect(screen.getByText(/npm-dual-server-name/)).toBeTruthy();
    expect(screen.getByText(/authelia-config/)).toBeTruthy();
    expect(screen.getByText(/cert-request/)).toBeTruthy();
  });

  it('surfaces per-step errors after a partial apply', async () => {
    const partialResult = {
      plan: {
        publicDomain: 'dopp.cloud',
        lanRoot: 'home.arpa',
        warnings: ['Nginx Proxy Manager is not deployed; proxy-host steps will be skipped.'],
        steps: [
          { kind: 'authelia-config', node: 'Local', skipped: false },
        ],
      },
      applied: true,
      errors: [{ step: 'authelia-config', detail: 'forced restart failure' }],
      stepResults: [{ ok: false, error: 'forced restart failure' }],
    };
    installFetch([
      { pattern: /\/api\/system\/mode$/, responder: () => jsonRes(LAN_MODE) },
      { pattern: /\/api\/system\/reverse-proxy\/preflight/, responder: () => jsonRes(PREFLIGHT_READY) },
      { pattern: /\/api\/system\/reverse-proxy\/migrate-to-public/, responder: () => jsonRes(partialResult) },
    ]);
    render(<PublicDomainSection />);
    await waitFor(() => expect(screen.getByPlaceholderText('example.com')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('example.com'), { target: { value: 'dopp.cloud' } });
    fireEvent.click(screen.getByRole('button', { name: /Check readiness/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Migrate to dopp.cloud/i })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Migrate to dopp.cloud/i }));
    });

    await waitFor(() => expect(screen.getByText(/finished with 1 error/i)).toBeTruthy());
    expect(screen.getByText(/Nginx Proxy Manager is not deployed/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry failed steps/i })).toBeTruthy();
  });
});
