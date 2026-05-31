/**
 * DomainTag (#249, relocated from the page-header ModeBadge) — renders
 * "<user> on <domain>" near the signed-in user. Public mode is plain
 * informational; LAN mode keeps the "add a public domain →" affordance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DomainTag from './DomainTag';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Fresh Response per URL — a shared body can only be read once, which
// breaks parallel callers (see feedback_vitest_fetch_response_reuse).
function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(routes).find(k => url.startsWith(k));
    if (!match) return new Response('null', { status: 404 });
    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('DomainTag', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows "<user> on <publicDomain>" in public mode, no upgrade link', async () => {
    global.fetch = mockFetch({
      '/api/system/mode': { mode: 'public', activeDomain: 'dopp.cloud', publicDomain: 'dopp.cloud', lanDomain: 'home.arpa' },
    }) as unknown as typeof fetch;

    render(<DomainTag username="mdopp" />);

    await waitFor(() => expect(screen.getByText('mdopp')).toBeDefined());
    expect(screen.getByText('dopp.cloud')).toBeDefined();
    expect(screen.queryByText(/add a public domain/i)).toBeNull();
  });

  it('keeps the "add a public domain" affordance in LAN mode', async () => {
    global.fetch = mockFetch({
      '/api/system/mode': { mode: 'lan', activeDomain: 'home.arpa', publicDomain: null, lanDomain: 'home.arpa' },
    }) as unknown as typeof fetch;

    render(<DomainTag username="mdopp" />);

    await waitFor(() => expect(screen.getByText('home.arpa')).toBeDefined());
    const link = screen.getByText(/add a public domain/i).closest('a');
    expect(link?.getAttribute('href')).toBe('/settings#reverse-proxy');
  });

  it('self-fetches the username from /api/auth/me when not supplied', async () => {
    global.fetch = mockFetch({
      '/api/system/mode': { mode: 'public', activeDomain: 'dopp.cloud', publicDomain: 'dopp.cloud', lanDomain: null },
      '/api/auth/me': { authenticated: true, username: 'alice' },
    }) as unknown as typeof fetch;

    render(<DomainTag />);

    await waitFor(() => expect(screen.getByText('alice')).toBeDefined());
  });
});
