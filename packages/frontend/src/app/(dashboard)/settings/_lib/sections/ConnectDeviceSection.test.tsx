/**
 * ConnectDeviceSection (#2251) — the admin "Connect Device" page. Acceptance #1:
 * after generating, the page shows a QR, the 6-char code, and an expiry
 * countdown. We mock the /napi/pair fetch and assert the rendered DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConnectDeviceSection from './ConnectDeviceSection';

vi.mock('../clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

function mockPairFetch(code = 'ABC234') {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/napi/pair') {
      return Promise.resolve(
        new Response(
          JSON.stringify({ code, qr_url: `https://box/napi/pair/redeem?code=${code}`, expires_at: expiresAt }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('ConnectDeviceSection (#2251)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('generates a code and shows QR + 6-char code + countdown', async () => {
    mockPairFetch('ABC234');
    render(<ConnectDeviceSection />);

    fireEvent.click(screen.getByTestId('pair-generate'));

    await waitFor(() => expect(screen.getByTestId('pair-panel')).toBeDefined());

    // QR rendered (qrcode.react emits an <svg>).
    const qr = screen.getByTestId('pair-qr');
    expect(qr.tagName.toLowerCase()).toBe('svg');
    // The 6-char code is shown.
    expect(screen.getByTestId('pair-code').textContent).toBe('ABC234');
    // A countdown is present (either "Expires in m:ss" or the expired notice).
    expect(screen.getByTestId('pair-countdown').textContent).toMatch(/Expires in|expired/);
  });

  it('surfaces an error when /napi/pair rejects (e.g. no admin session)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'admin session required' }), { status: 401 })),
    ));
    render(<ConnectDeviceSection />);
    fireEvent.click(screen.getByTestId('pair-generate'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toMatch(/admin session required/);
  });
});
