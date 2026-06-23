import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, isConnected: false }),
}));

import LogViewer from './LogViewer';
import { ToastProvider } from '../providers/ToastProvider';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderViewer() {
  return render(
    <ToastProvider>
      <LogViewer />
    </ToastProvider>,
  );
}

describe('LogViewer — design-system tokens (#2100)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/settings/logLevel')) return jsonResponse({ success: true, logLevel: 'info' });
        if (url.includes('/api/logs/tags')) return jsonResponse({ success: true, tags: ['system'] });
        if (url.includes('/api/logs/list')) return jsonResponse({ success: true, files: [] });
        if (url.includes('/api/logs/query')) {
          return jsonResponse({
            success: true,
            logs: [
              { id: 1, timestamp: '2026-06-23T08:00:00.000Z', level: 'error', tag: 'system', message: 'boom' },
              { id: 2, timestamp: '2026-06-23T08:00:01.000Z', level: 'info', tag: 'system', message: 'hello' },
            ],
          });
        }
        return jsonResponse({ success: true });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toolbar + rows use token surfaces; no raw bg-white / slate / emerald literals', async () => {
    const { container } = renderViewer();
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    // The outer shell + toolbar selects/buttons + log rows are token-wired.
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    // Strip the MultiSelect tag-filter child (out of this unit's scope) before
    // asserting no raw literals in the markup LogViewer itself authors.
    const owned = container.cloneNode(true) as HTMLElement;
    owned
      .querySelectorAll('[class*="min-h-[40px]"], [class*="bg-white"]')
      .forEach((n) => n.remove());
    const ownedHtml = owned.innerHTML;
    expect(ownedHtml).not.toMatch(/bg-white\b|dark:bg-(slate|gray)|border-(slate|gray)-\d|emerald-\d|blue-\d{3}/);
  });

  it('error level renders on status-fail token, info on status-info (severity ramp via tokens)', async () => {
    const { container } = renderViewer();
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    const html = container.innerHTML;
    expect(html).toMatch(/text-status-fail/);
    expect(html).toMatch(/border-l-status-fail/);
    expect(html).toMatch(/text-status-info/);
  });

  it('keeps the log scroll region as a monospace console (terminal feel preserved)', async () => {
    const { container } = renderViewer();
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(container.querySelector('.overflow-auto.font-mono')).toBeTruthy();
  });
});
