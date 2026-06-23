import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import ContainerLogsPanel from './ContainerLogsPanel';

function renderPanel(over: Partial<Parameters<typeof ContainerLogsPanel>[0]['container']> = {}) {
  return render(
    <ContainerLogsPanel
      container={{ id: 'abcdef012345', name: 'immich', state: 'running', ...over }}
      onClose={vi.fn()}
    />,
  );
}

describe('ContainerLogsPanel — design-system tokens (#2100)', () => {
  beforeEach(() => {
    // Detail fetch + log stream both resolve to empty so render settles.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/logs/stream')) {
          return new Response('', { status: 200 });
        }
        return new Response(JSON.stringify({ Config: { Env: [] } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('panel chrome (header + info sidebar) uses token surfaces, no raw gray/slate literals', async () => {
    const { container } = renderPanel();
    expect(screen.getByText('immich')).toBeTruthy();
    // Assert against the chrome only (header + info sidebar) — the dark
    // terminal log well is an intentional console surface, asserted separately.
    const header = container.querySelector('.border-b.border-border') as HTMLElement;
    const sidebar = container.querySelector('.bg-surface-muted') as HTMLElement;
    expect(header).toBeTruthy();
    expect(sidebar).toBeTruthy();
    const chrome = header.outerHTML + sidebar.outerHTML;
    expect(chrome).toMatch(/bg-surface/);
    expect(chrome).toMatch(/border-border/);
    expect(chrome).not.toMatch(/bg-white\b|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d/);
  });

  it('container State indicator uses the Badge primitive on status tokens', async () => {
    const { container } = renderPanel({ state: 'running' });
    const badge = container.querySelector('[data-variant="ok"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('running');
  });

  it('keeps the log body as a monospace terminal console (dark well preserved)', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText('Live Logs')).toBeTruthy());
    // The console body stays a fixed dark terminal surface, not a Card.
    expect(container.querySelector('.bg-gray-950')).toBeTruthy();
    expect(container.querySelector('.font-mono')).toBeTruthy();
  });
});
