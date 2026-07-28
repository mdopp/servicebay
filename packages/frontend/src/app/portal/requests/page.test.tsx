/**
 * `/portal/requests` — deep-linkable request-access route (#2405).
 *
 * The companion app (mdopp/solaris-android#50) links straight here, so the
 * contract these tests pin is: the form is **already open** for an
 * anonymous visitor (no extra click), the LAN gate behaves exactly like
 * `/portal`'s, and a signed-in visitor is sent to `/portal` instead of
 * being shown a form for an account they already have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { redirect, getConfig, verifyAutheliaSession, headersMock, buildPortalCards } = vi.hoisted(() => ({
  redirect: vi.fn(),
  getConfig: vi.fn(),
  verifyAutheliaSession: vi.fn(),
  headersMock: vi.fn(),
  buildPortalCards: vi.fn(),
}));

// The real redirect() throws to unwind rendering; the unit under test is
// "where do we send a signed-in visitor", so the spy call is the contract
// (same pattern as app/(dashboard)/redirects.test.tsx).
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/headers', () => ({ headers: headersMock }));
// Spread the real module so `ConfigReadError` (which both pages branch on
// since #2421) stays the genuine class; only the reads are stubbed.
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getConfig,
  getAdminBaseUrl: () => null,
}));
vi.mock('@/lib/portal/auth', () => ({ verifyAutheliaSession }));
vi.mock('@/lib/portal/services', () => ({ buildPortalCards }));
// The LAN gate itself is NOT mocked — both routes must run the real
// isPortalBlockedForRequest so "same gate" is actually proven.

/** Anonymous, LAN-shaped visit (X-Real-IP set by NPM). */
const lanHeaders = () => new Headers({ 'x-real-ip': '192.168.1.42' });
/** Off-LAN visit — a public source IP forwarded by the proxy. */
const wanHeaders = () => new Headers({ 'x-real-ip': '203.0.113.7' });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  getConfig.mockResolvedValue({ portalLanOnly: false });
  verifyAutheliaSession.mockResolvedValue({ user: null, name: null });
  buildPortalCards.mockResolvedValue([]);
  headersMock.mockResolvedValue(lanHeaders());
});

async function renderRequestsPage() {
  const { default: Page } = await import('./page');
  render(await Page());
}

describe('/portal/requests — deep link opens the form', () => {
  it('renders the request-access form already open, with no extra click', async () => {
    await renderRequestsPage();
    expect(screen.getByRole('heading', { name: /Request Access/i })).toBeTruthy();
    // The actual form controls, not just a CTA button.
    expect(screen.getByRole('button', { name: /Send request/i })).toBeTruthy();
    expect(screen.getByPlaceholderText(/max\.mustermann/i)).toBeTruthy();
    // …and no "Don't have an account yet?" button to click first.
    expect(screen.queryByRole('button', { name: /have an account/i })).toBeNull();
  });

  it('does not redirect an anonymous visitor', async () => {
    await renderRequestsPage();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('/portal/requests — signed-in visitor', () => {
  it('goes to /portal instead of a form for an account they already have', async () => {
    verifyAutheliaSession.mockResolvedValue({ user: 'max', name: 'Max Mustermann' });
    await renderRequestsPage();
    expect(redirect).toHaveBeenCalledWith('/portal');
  });
});

describe('/portal/requests — LAN gate parity with /portal', () => {
  it('shows the same LAN-only notice off-LAN when portalLanOnly is on', async () => {
    getConfig.mockResolvedValue({ portalLanOnly: true });
    headersMock.mockResolvedValue(wanHeaders());
    await renderRequestsPage();
    expect(screen.getByText(/available on the home network only/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send request/i })).toBeNull();
  });

  it('/portal blocks under exactly the same conditions', async () => {
    getConfig.mockResolvedValue({ portalLanOnly: true });
    headersMock.mockResolvedValue(wanHeaders());
    const { default: PortalPage } = await import('../page');
    render(await PortalPage());
    expect(screen.getByText(/available on the home network only/i)).toBeTruthy();
  });

  it('renders the form on-LAN when portalLanOnly is on', async () => {
    getConfig.mockResolvedValue({ portalLanOnly: true });
    headersMock.mockResolvedValue(lanHeaders());
    await renderRequestsPage();
    expect(screen.getByRole('button', { name: /Send request/i })).toBeTruthy();
  });
});

describe('/portal is unaffected by the new route', () => {
  it('still renders the CTA button, not an open form', async () => {
    const { default: PortalPage } = await import('../page');
    render(await PortalPage());
    expect(screen.getByRole('button', { name: /have an account/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send request/i })).toBeNull();
  });
});
