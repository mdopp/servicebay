/**
 * AutoUpdateWindowNudge (#2396).
 *
 * The whole point of the component is a distinction the UI never drew, so the
 * assertions are about *what it says* and *when it says it*, not just that it
 * renders: it must name both mechanisms (per-service container images vs the
 * ServiceBay app itself), it must only appear while `config.updateWindow` is
 * absent, and it must vanish the moment the operator has made a choice —
 * including an explicit `{ enabled: false }` opt-out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AutoUpdateWindowNudge, { UPDATE_WINDOW_SETTINGS_HREF } from './AutoUpdateWindowNudge';

function stubWindowResponse(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AutoUpdateWindowNudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Silence the deliberate console.error on the read-failure paths.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the update-window setting from GET /api/system/update-window', async () => {
    const fetchMock = stubWindowResponse({ window: null });
    render(<AutoUpdateWindowNudge />);
    // The GET now goes out through the typed api-client's `apiFetch`, which
    // always forwards an `init` slot — undefined for a bodyless read. Same
    // request on the wire.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/system/update-window', undefined));
  });

  it('renders the nudge when no update window has ever been configured', async () => {
    stubWindowResponse({ window: null });
    render(<AutoUpdateWindowNudge />);
    expect(await screen.findByText(/not auto-updating yet/i)).toBeDefined();
  });

  it('explains BOTH mechanisms and that they are distinct (the actual confusion, #2396)', async () => {
    stubWindowResponse({ window: null });
    const { container } = render(<AutoUpdateWindowNudge />);
    await screen.findByText(/not auto-updating yet/i);
    const text = container.textContent ?? '';

    // Half 1: per-service container images are locked until a window is picked.
    expect(text).toMatch(/locked until you pick a maintenance window/i);
    expect(text).toMatch(/:latest/);
    // Half 2: the ServiceBay app updater is a DIFFERENT thing, unaffected.
    expect(text).toMatch(/separate from ServiceBay's own\s+updates/i);
    expect(text).toMatch(/ServiceBay is up to date.*does not mean your services are/i);
  });

  it('links to the Auto-update window setting in Settings → System', async () => {
    stubWindowResponse({ window: null });
    render(<AutoUpdateWindowNudge />);
    const link = await screen.findByRole('link', { name: /auto-update window/i });
    expect(link.getAttribute('href')).toBe(UPDATE_WINDOW_SETTINGS_HREF);
    expect(UPDATE_WINDOW_SETTINGS_HREF).toBe('/settings/system#update-window');
  });

  it('disappears once an operator has configured an enabled window (no forever-nagging)', async () => {
    stubWindowResponse({
      window: {
        enabled: true,
        days: ['Sat'],
        startTime: '03:00',
        lengthMinutes: 120,
        applyTo: { os: true, containers: true, servicebay: false },
      },
    });
    const { container } = render(<AutoUpdateWindowNudge />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('also disappears on an explicit opt-out ({ enabled: false }) — that is a decision, not a gap', async () => {
    stubWindowResponse({
      window: {
        enabled: false,
        days: ['Sat', 'Sun'],
        startTime: '03:00',
        lengthMinutes: 120,
        applyTo: { os: true, containers: true, servicebay: false },
      },
    });
    const { container } = render(<AutoUpdateWindowNudge />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders nothing before the read resolves (no flash of a warning)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    const { container } = render(<AutoUpdateWindowNudge />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the read fails — a fetch blip is not a warning', async () => {
    stubWindowResponse({}, false);
    const { container } = render(<AutoUpdateWindowNudge />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders nothing when the read throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    const { container } = render(<AutoUpdateWindowNudge />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders on the token Card surface with status tokens, not raw colour literals', async () => {
    stubWindowResponse({ window: null });
    const { container } = render(<AutoUpdateWindowNudge />);
    await screen.findByText(/not auto-updating yet/i);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/bg-surface|border-status-warn|bg-status-warn/);
    const html = root.outerHTML;
    expect(html).not.toMatch(/(border|bg|text)-(blue|amber|yellow|red|gray)-\d/);
  });
});
