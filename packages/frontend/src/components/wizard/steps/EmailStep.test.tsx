import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { EmailStep } from './EmailStep';

const saveEmailConfig = vi.fn(async () => undefined);
vi.mock('@/app/actions/onboarding', () => ({
  saveEmailConfig: (...a: unknown[]) => saveEmailConfig(...a),
}));

function cfg(over: Record<string, unknown> = {}) {
  return { host: '', port: 587, secure: false, user: '', pass: '', from: '', recipients: '', ...over } as never;
}

describe('EmailStep — design-system tokens (#2100)', () => {
  beforeEach(() => {
    saveEmailConfig.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses token surfaces/borders, no raw gray/emerald/red/blue surface literals on its own chrome', () => {
    const { container } = render(<EmailStep emailConfig={cfg()} setEmailConfig={() => {}} />);
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface|status-fail/);
    expect(html).toMatch(/border-border|status-/);
    // EmailStep's own surfaces no longer use raw white/5, gray-50/50, emerald-, red-500 literals
    expect(html).not.toMatch(/bg-white\/5|bg-gray-50|bg-emerald-|text-emerald-|bg-red-500\/10|text-red-500/);
  });

  it('saves SMTP config and sends a test to the first recipient (behaviour preserved)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EmailStep emailConfig={cfg({ host: 'smtp.x', user: 'u@x', recipients: 'a@x, b@x' })} setEmailConfig={() => {}} />);
    fireEvent.click(screen.getByText(/Verify SMTP/));
    await waitFor(() => expect(saveEmailConfig).toHaveBeenCalled());
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u]) => String(u).includes('/email/test'));
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ to: 'a@x' });
    });
    await waitFor(() => expect(screen.getByText(/Test email sent to a@x/)).toBeTruthy());
  });

  it('disables verify until host, user, and recipients are present', () => {
    render(<EmailStep emailConfig={cfg()} setEmailConfig={() => {}} />);
    expect((screen.getByText(/Verify SMTP/).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
