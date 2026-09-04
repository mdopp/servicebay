import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { EmailStep } from './EmailStep';

const { saveEmailConfig } = vi.hoisted(() => ({
  saveEmailConfig: vi.fn(async (...a: unknown[]) => { void a; return { success: true as const }; }),
}));
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  saveEmailConfig,
}));

interface TestEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  recipients: string;
}

function cfg(over: Partial<TestEmailConfig> = {}): TestEmailConfig {
  return { host: '', port: 587, secure: false, user: '', pass: '', from: '', recipients: '', ...over };
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
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _opts?: RequestInit) => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
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

  it('renders the SSL/TLS toggle as a real checkbox input and wires onChange (ui Input primitive)', () => {
    function Harness() {
      const [emailConfig, setEmailConfig] = useState<TestEmailConfig>(cfg({ secure: false }));
      return <EmailStep emailConfig={emailConfig} setEmailConfig={setEmailConfig} />;
    }
    render(<Harness />);
    const checkbox = screen.getByLabelText('Use SSL/TLS') as HTMLInputElement;
    expect(checkbox.tagName).toBe('INPUT');
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });
});
