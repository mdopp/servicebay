import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import LogLevelControl from './LogLevelControl';
import { ToastProvider } from '../providers/ToastProvider';

function renderControl() {
  return render(
    <ToastProvider>
      <LogLevelControl />
    </ToastProvider>,
  );
}

describe('LogLevelControl — design-system tokens (#2100)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, logLevel: 'warn' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses token surfaces/borders, no raw bg-white / gray / slate literals', async () => {
    const { container } = renderControl();
    // Loaded level reflected (functional fetch intact).
    await waitFor(() => {
      const select = screen.getByLabelText('Verbosity Level') as HTMLSelectElement;
      expect(select.value).toBe('warn');
    });
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d/);
  });

  it('wraps the verbosity select in the Field primitive (label wired to control)', async () => {
    renderControl();
    // getByLabelText resolves only if the <label> htmlFor wires to the select id.
    await waitFor(() => expect(screen.getByLabelText('Verbosity Level')).toBeTruthy());
  });
});
