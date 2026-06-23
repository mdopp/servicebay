import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { StackManifest, ServiceViewModel } from '@servicebay/api-client';

import StackGroupHeader from './StackGroupHeader';
import { ToastProvider } from '../providers/ToastProvider';
import type { ServiceStackGroup } from '@/dashboards/_lib/servicesDashboard';

function manifest(over: Partial<StackManifest> = {}): StackManifest {
  return {
    name: 'immich',
    label: 'Photos',
    tier: 'feature',
    lifecycle: 'wipeable',
    dependsOnStacks: [],
    templates: ['immich'],
    ...over,
  };
}

function group(over: Partial<ServiceStackGroup> = {}): ServiceStackGroup {
  return {
    id: 'immich',
    label: 'Photos',
    manifest: manifest(),
    wipeable: true,
    services: [{ id: 'immich', name: 'immich.service', displayName: 'Immich' } as ServiceViewModel],
    ...over,
  };
}

function renderHeader(g: ServiceStackGroup, onWiped = vi.fn()) {
  return render(
    <ToastProvider>
      <StackGroupHeader group={g} onWiped={onWiped} />
    </ToastProvider>,
  );
}

describe('StackGroupHeader (#2081)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the stack label and a danger wipe button for a wipeable stack', () => {
    renderHeader(group());
    expect(screen.getByText('Photos')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /wipe photos stack/i });
    expect(btn.getAttribute('data-variant')).toBe('danger');
  });

  it('does NOT render a wipe button for a non-wipeable (core / atomic-wipe) group', () => {
    renderHeader(group({ wipeable: false, label: 'Core', id: 'basic' }));
    expect(screen.queryByRole('button', { name: /wipe/i })).toBeNull();
  });

  it('does NOT render a wipe button for the ungrouped bucket', () => {
    renderHeader(group({ wipeable: false, id: '__ungrouped__', label: 'Ungrouped', manifest: null }));
    expect(screen.queryByRole('button', { name: /wipe/i })).toBeNull();
  });

  it('is confirm-gated: opening the dialog does NOT fire any request until the token is typed', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHeader(group());

    fireEvent.click(screen.getByRole('button', { name: /wipe photos stack/i }));
    // Dialog is open with a blocking type-to-confirm; nothing fired yet.
    expect(screen.getByRole('dialog')).toBeTruthy();
    const confirmBtn = screen.getByRole('button', { name: /wipe stack/i });
    fireEvent.click(confirmBtn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wipe is SCOPED: hits /api/system/stacks/<name>/wipe with the WIPE-<name> token, never the system-wide reset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, deleted: ['immich'], failed: [], capabilityFailures: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onWiped = vi.fn();
    renderHeader(group(), onWiped);

    fireEvent.click(screen.getByRole('button', { name: /wipe photos stack/i }));
    // type the exact confirmation token to enable Confirm
    const input = screen.getByRole('dialog').querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'WIPE-immich' } });
    fireEvent.click(screen.getByRole('button', { name: /wipe stack/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/system/stacks/immich/wipe');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ confirm: 'WIPE-immich' });
    // The system-wide nuke is never the target.
    expect(url).not.toContain('/stacks/reset');
    await waitFor(() => expect(onWiped).toHaveBeenCalled());
  });
});
