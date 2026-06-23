import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import ExternalLinkConfig from './ExternalLinkConfig';
import { ToastProvider } from '@/providers/ToastProvider';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

function renderConfig() {
  return render(
    <ToastProvider>
      <ExternalLinkConfig />
    </ToastProvider>,
  );
}

describe('ExternalLinkConfig — design-system tokens (#2100)', () => {
  beforeEach(() => {
    push.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses token surfaces/borders, no raw bg-white / gray / blue color literals', () => {
    const { container } = renderConfig();
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d|bg-blue-\d/);
  });

  it('POSTs the link with type=link and redirects on success (behaviour preserved)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderConfig();
    fireEvent.change(screen.getByPlaceholderText('e.g. Home Assistant'), { target: { value: 'HA' } });
    fireEvent.change(screen.getByPlaceholderText('http://192.168.1.10:8123'), { target: { value: 'http://ha.local' } });
    fireEvent.click(screen.getByText('Save Link'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/services');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ name: 'HA', url: 'http://ha.local', type: 'link' });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/services'));
  });

  it('blocks save when name or URL missing (no fetch)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderConfig();
    fireEvent.click(screen.getByText('Save Link'));
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/services')).toBe(false);
  });
});
