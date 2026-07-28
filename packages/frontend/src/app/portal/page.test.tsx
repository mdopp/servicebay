/**
 * The anonymous portal degrades instead of exploding (#2421).
 *
 * #2399 turned `getConfig()` from "never throws, returns defaults" into
 * "retry 3×, then throw `ConfigReadError`". `/portal` and `/portal/requests`
 * are the two pre-auth, family-facing routes; before this, a transient read
 * blip bubbled to the app-root `error.tsx` — an operator screen ("Something
 * went wrong", "Run diagnostics") shown to a household member with no admin
 * recourse.
 *
 * What these tests pin, for BOTH routes: a throwing config read renders the
 * portal shell with a temporarily-unavailable message; a readable config
 * leaves both routes exactly as they were; and anything else that throws in
 * the segment lands on the portal-scoped boundary, not the app-root one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigReadError } from '@/lib/config';

const { getConfig, verifyAutheliaSession, headersMock, buildPortalCards, redirect } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  verifyAutheliaSession: vi.fn(),
  headersMock: vi.fn(),
  buildPortalCards: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/headers', () => ({ headers: headersMock }));
// `ConfigReadError` is the REAL class from the real module — the pages branch
// on `instanceof`, so a stand-in would prove nothing about production.
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getConfig,
  getAdminBaseUrl: () => null,
}));
vi.mock('@/lib/portal/auth', () => ({ verifyAutheliaSession }));
vi.mock('@/lib/portal/services', () => ({ buildPortalCards }));

/** Anonymous, LAN-shaped visit (X-Real-IP set by NPM). */
const lanHeaders = () => new Headers({ 'x-real-ip': '192.168.1.42' });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  getConfig.mockResolvedValue({ portalLanOnly: false });
  verifyAutheliaSession.mockResolvedValue({ user: null, name: null });
  buildPortalCards.mockResolvedValue([]);
  headersMock.mockResolvedValue(lanHeaders());
});

const renderPortal = async () => {
  const { default: Page } = await import('./page');
  render(await Page());
};
const renderRequests = async () => {
  const { default: Page } = await import('./requests/page');
  render(await Page());
};

const routes: [string, () => Promise<void>][] = [
  ['/portal', renderPortal],
  ['/portal/requests', renderRequests],
];

describe.each(routes)('%s — config read fails', (_route, renderRoute) => {
  beforeEach(() => {
    getConfig.mockRejectedValue(new ConfigReadError('Failed to read config.json after 3 attempts'));
  });

  it('renders the portal shell with a temporarily-unavailable message', async () => {
    await renderRoute();
    expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy();
  });

  it('does not show the operator-facing app-root error screen', async () => {
    await renderRoute();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(screen.queryByText(/Run diagnostics/i)).toBeNull();
  });

  it('shows no service grid and no request form behind the unknown LAN gate', async () => {
    await renderRoute();
    expect(screen.queryByRole('button', { name: /Send request/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /have an account/i })).toBeNull();
  });

  it('still propagates a non-ConfigReadError to the boundary', async () => {
    getConfig.mockRejectedValue(new Error('boom'));
    await expect(renderRoute()).rejects.toThrow('boom');
  });
});

describe('config readable — both routes unchanged', () => {
  it('/portal still renders the hero and the request-access CTA', async () => {
    await renderPortal();
    expect(screen.getByRole('heading', { name: /Home/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /have an account/i })).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });

  it('/portal/requests still opens the form', async () => {
    await renderRequests();
    expect(screen.getByRole('button', { name: /Send request/i })).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });
});

describe('portal-scoped error boundary', () => {
  it('renders the portal notice, not the app-root screen, and offers a retry', async () => {
    const reset = vi.fn();
    const { default: PortalError } = await import('./error');
    render(<PortalError error={Object.assign(new Error('boom'), { digest: 'abc123' })} reset={reset} />);

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(screen.queryByText(/abc123/)).toBeNull();
    screen.getByRole('button', { name: /Try again/i }).click();
    expect(reset).toHaveBeenCalled();
  });
});
