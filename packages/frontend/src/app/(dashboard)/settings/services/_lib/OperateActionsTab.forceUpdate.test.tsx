/**
 * "Force update" control on the service Actions tab (#2397).
 *
 * Own file (rather than extra cases in OperateActionsTab.test.tsx) because the
 * fresh-pull fallback goes through the REAL ConfirmModal — the sibling file
 * stubs ConfirmModal to null for the delete-layout assertions.
 *
 * These are the DOM-level proof of the issue's acceptance: an operator can
 * trigger a force-update on a specific service from the UI, and a stuck image
 * can be refreshed through the fallback path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import OperateActionsTab, { describeForceUpdate } from './OperateActionsTab';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const toasts = vi.hoisted(() => ({
  add: vi.fn(() => 'toast-1'),
  update: vi.fn(),
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: toasts.add, updateToast: toasts.update }),
}));
vi.mock('@/components/ActionProgressModal', () => ({ default: () => null }));

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'media.service',
    displayName: 'Media',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'kube',
    ports: [],
    ...over,
  };
}

/** Last body POSTed to the action route, parsed. */
function lastPost(): { url: string; body: Record<string, unknown> } {
  const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, { body: string }];
  return { url, body: JSON.parse(init.body) };
}

function respond(report: Record<string, unknown>, ok = true) {
  (global.fetch as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => report,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn() as unknown as typeof fetch;
  respond({ changed: true, images: [{ image: 'jellyfin:latest', changed: true }] });
});

describe('OperateActionsTab force update (#2397)', () => {
  it('offers a Force update control and posts the force-update action for THIS service', async () => {
    render(<OperateActionsTab service={svc()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Force update' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const { url, body } = lastPost();
    expect(url).toBe('/api/services/media.service/action');
    expect(body).toEqual({ action: 'force-update', mode: 'pull' });
  });

  it('targets the service on its own node when the service is not Local', async () => {
    render(<OperateActionsTab service={svc({ nodeName: 'nas01' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Force update' }));
    await waitFor(() => expect(lastPost().url).toBe('/api/services/media.service/action?node=nas01'));
  });

  it('reports the new image and hides the fallback when the pull landed', async () => {
    render(<OperateActionsTab service={svc()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Force update' }));

    await waitFor(() => expect(toasts.update).toHaveBeenCalled());
    expect(toasts.update).toHaveBeenCalledWith('toast-1', 'success', 'New image pulled', expect.stringContaining('jellyfin:latest'));
    // It worked → no fallback offered.
    expect(screen.queryByRole('button', { name: 'Fresh pull' })).toBeNull();
  });

  it('does not surface the fresh-pull fallback until it is needed', () => {
    render(<OperateActionsTab service={svc()} />);
    expect(screen.queryByRole('button', { name: 'Fresh pull' })).toBeNull();
    expect(screen.queryByText(/deletes the local\s+image/)).toBeNull();
  });

  it('reveals the fresh-pull fallback when the image is stuck, and runs it through a confirm', async () => {
    respond({ changed: false, stale: true, images: [{ image: 'jellyfin:latest', stale: true }] });
    render(<OperateActionsTab service={svc()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Force update' }));

    // Honest reporting first: the operator is told the image did NOT update.
    await waitFor(() => expect(toasts.update).toHaveBeenCalledWith('toast-1', 'warning', 'Image did not update', expect.any(String)));

    // …then the fallback appears, with an explanation of what it does.
    const fresh = await screen.findByRole('button', { name: 'Fresh pull' });
    expect(screen.getByText(/deletes the local/)).toBeDefined();

    respond({ changed: true, mode: 'fresh', images: [{ image: 'jellyfin:latest', changed: true }] });
    fireEvent.click(fresh);
    // Deleting the local image is confirmed, not silently done — and the dialog
    // spells out what is deleted (image + containers, not data).
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/local image/);
    expect(dialog.textContent).toMatch(/No volumes or config are touched/);
    fireEvent.click(screen.getByRole('button', { name: /Delete image and pull/ }));

    await waitFor(() => expect(lastPost().body).toEqual({ action: 'force-update', mode: 'fresh' }));
    // A landed fresh pull puts the fallback away again.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fresh pull' })).toBeNull());
  });

  it('offers the fallback after a failed request too (a stuck image can hide a 500)', async () => {
    respond({ error: 'boom' }, false);
    render(<OperateActionsTab service={svc()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Force update' }));
    await waitFor(() => expect(toasts.update).toHaveBeenCalledWith('toast-1', 'error', 'Force update failed', 'boom'));
    expect(await screen.findByRole('button', { name: 'Fresh pull' })).toBeDefined();
  });

  it('leaves the pre-existing lifecycle actions in place (#2078/#2393 layout)', () => {
    render(<OperateActionsTab service={svc()} />);
    for (const label of ['Start', 'Stop', 'Update & Restart', 'Force update']) {
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });
});

describe('describeForceUpdate (#2397 — a no-op must read as a no-op)', () => {
  it('a landed pull is a success naming the image', () => {
    expect(describeForceUpdate({ changed: true, images: [{ image: 'a:1', changed: true }] }))
      .toMatchObject({ type: 'success', title: 'New image pulled' });
  });

  it('a stuck image is a warning that points at the fallback', () => {
    const d = describeForceUpdate({ changed: false, stale: true, images: [{ image: 'a:1', stale: true }] });
    expect(d.type).toBe('warning');
    expect(d.message).toMatch(/fresh pull/i);
  });

  it('a failed pull is the headline even when another image advanced', () => {
    const d = describeForceUpdate({ changed: true, images: [{ image: 'a:1', changed: true }, { image: 'b:2', error: 'no such host' }] });
    expect(d.type).toBe('error');
    expect(d.message).toContain('b:2');
  });

  it('nothing newer published is a success that says so, not "update sent"', () => {
    const d = describeForceUpdate({ changed: false, images: [{ image: 'a:1' }] });
    expect(d).toMatchObject({ type: 'success', title: 'Already on the newest image' });
    expect(d.message).not.toMatch(/sent/);
  });
});
