import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useServiceActions } from './useServiceActions';

// The three heavy leaf surfaces have their own suites (ServiceMonitor.test.tsx,
// ServiceForm / ActionProgressModal); stub them so this spec measures the
// hook's own overlay chrome — the modal panel, the action buttons, the drawer
// header/body — which is where the design tokens live. ConfirmModal and
// WorkspaceDrawer render for real: the delete-confirm copy and the drawer
// header are passed to them as ReactNode props, so the real components are
// what put those nodes in the DOM.
vi.mock('@/components/ServiceMonitor', () => ({
  default: ({ serviceName }: { serviceName: string }) => <div data-testid="service-monitor">{serviceName}</div>,
}));
vi.mock('@/components/ServiceForm', () => ({
  default: () => <div data-testid="service-form" />,
}));
vi.mock('@/components/ActionProgressModal', () => ({
  default: ({ isOpen, action }: { isOpen: boolean; action: string }) =>
    isOpen ? <div data-testid="action-progress">{action}</div> : null,
}));

const addToast = vi.fn(() => 'toast-1');
const updateToast = vi.fn();
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast, updateToast }),
}));

const service: ServiceViewModel = {
  name: 'immich.service',
  displayName: 'immich',
  yamlBasename: 'immich.yml',
  kubeBasename: 'immich.kube',
  id: 'immich.service',
  description: 'Photo library',
  nodeName: 'attic',
  active: true,
  type: 'kube',
  ports: [],
};

/**
 * Mounts the hook and exposes its entry points as plain buttons, so a test
 * drives them the way a dashboard does (click) rather than reaching into the
 * hook's return value.
 */
function Harness({ onRefresh }: { onRefresh?: () => void } = {}) {
  const actions = useServiceActions({ onRefresh });
  return (
    <>
      <button onClick={() => actions.openActions(service)}>drive:open-actions</button>
      <button onClick={() => actions.requestDelete(service)}>drive:request-delete</button>
      <button onClick={() => actions.openMonitorDrawer(service)}>drive:open-monitor</button>
      <button onClick={() => actions.openEditDrawer(service)}>drive:open-edit</button>
      <button onClick={() => actions.openEditDrawer({ ...service, type: 'container' })}>drive:open-edit-plain</button>
      {actions.overlays}
    </>
  );
}

/** Click one of the Harness drive buttons. */
function drive(what: string): void {
  act(() => {
    screen.getByRole('button', { name: `drive:${what}` }).click();
  });
}

/** First element carrying the exact class token, searched across the document. */
function byClass(cls: string): Element {
  const found = document.querySelector(`[class~="${cls}"]`);
  expect(found, `no element with class "${cls}"`).not.toBeNull();
  return found!;
}

/** The lucide <svg> rendered inside the action button labelled `label`. */
function iconOf(label: string): Element {
  const btn = screen.getByRole('button', { name: label });
  const svg = btn.querySelector('svg');
  expect(svg, `no icon svg inside "${label}"`).not.toBeNull();
  return svg!;
}

const fetchMock = vi.fn();

describe('useServiceActions overlays', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    addToast.mockClear();
    updateToast.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('actions modal', () => {
    beforeEach(() => {
      render(<Harness />);
      drive('open-actions');
    });

    it('paints the panel and its chrome with surface/border tokens', () => {
      expect(screen.getByText('Service Actions')).toBeTruthy();

      // Modal panel: bg-surface + border-border (was bg-white/dark:bg-gray-900).
      const panel = byClass('bg-surface');
      expect(panel.className).toContain('border-border');
      expect(panel.className).not.toMatch(/bg-white|dark:bg-gray-/);

      // The selected-service summary sits on the raised surface token.
      const summary = byClass('bg-surface-2');
      expect(summary.textContent).toContain('immich.service');
      expect(summary.querySelector('.text-text')?.textContent).toBe('immich.service');
      expect(summary.querySelector('.text-text-muted')?.textContent).toBe('Systemd Service');

      // Back + close buttons use the muted→default text token pair.
      for (const name of ['Back', 'Close service actions']) {
        const btn = screen.getByRole('button', { name });
        expect(btn.className).toContain('text-text-muted');
        expect(btn.className).toContain('hover:text-text');
      }
    });

    it('maps each action to its semantic status token', () => {
      expect(iconOf('Start').getAttribute('class')).toContain('text-status-ok');
      expect(iconOf('Stop').getAttribute('class')).toContain('text-status-fail');
      expect(iconOf('Restart Service').getAttribute('class')).toContain('text-status-info');
      expect(iconOf('Update & Restart').getAttribute('class')).toContain('text-status-warn');
    });

    it('gives every action button the neutral border/hover tokens', () => {
      for (const label of ['Start', 'Stop', 'Restart Service', 'Update & Restart']) {
        const btn = screen.getByRole('button', { name: label });
        expect(btn.className).toContain('border-border');
        expect(btn.className).toContain('hover:bg-surface-2');
        expect(btn.className).not.toMatch(/border-gray-|bg-gray-/);
      }
      // fullWidth only applies to the two stacked buttons.
      expect(screen.getByRole('button', { name: 'Restart Service' }).className).toContain('w-full');
      expect(screen.getByRole('button', { name: 'Start' }).className).not.toContain('w-full');
    });

    it('renders Delete Service as a status-fail tinted button', () => {
      const del = screen.getByRole('button', { name: 'Delete Service' });
      expect(del.className).toContain('text-status-fail');
      expect(del.className).toContain('bg-status-fail/10');
      expect(del.className).toContain('border-status-fail/20');
      expect(del.className).toContain('hover:bg-status-fail/20');
      expect(del.className).not.toMatch(/red-\d/);
    });

    it('shows the status-info spinner on the in-flight action button', async () => {
      // `update` is the non-modal path: it keeps runningAction set for the
      // duration of the POST, which is what drives the per-button spinner.
      let release: (r: Response) => void = () => {};
      fetchMock.mockReturnValue(new Promise<Response>(res => { release = res; }));

      act(() => {
        screen.getByRole('button', { name: 'Update & Restart' }).click();
      });

      const running = await screen.findByRole('button', { name: 'Running…' });
      const spinner = running.querySelector('svg')!;
      expect(spinner.getAttribute('class')).toContain('animate-spin');
      expect(spinner.getAttribute('class')).toContain('text-status-info');
      // Only the in-flight button swaps to the spinner.
      expect(screen.getByRole('button', { name: 'Start' }).querySelector('svg')!.getAttribute('class'))
        .toContain('text-status-ok');

      await act(async () => {
        release(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      });
      await waitFor(() => expect(screen.queryByText('Running…')).toBeNull());
    });

    it('hands the start/stop/restart actions to the progress modal', async () => {
      act(() => {
        screen.getByRole('button', { name: 'Start' }).click();
      });
      expect((await screen.findByTestId('action-progress')).textContent).toBe('start');
      // The actions panel yields to the modal.
      expect(screen.queryByText('Service Actions')).toBeNull();
    });
  });

  describe('delete confirmation', () => {
    it('tokenises the destructive copy: muted body, info safety-net, fail warning', () => {
      render(<Harness />);
      drive('request-delete');

      const body = screen.getByText(/You are about to delete/).closest('p')!;
      expect(body.className).toContain('text-text-muted');
      expect(body.querySelector('.text-text')?.textContent).toBe('immich.service');

      const safetyNet = screen.getByText(/Safety Net Active/).closest('div')!;
      expect(safetyNet.className).toContain('bg-status-info/10');
      expect(safetyNet.className).toContain('border-status-info/20');
      expect(safetyNet.className).toContain('text-status-info');
      expect(safetyNet.className).not.toMatch(/blue-\d/);

      const warning = screen.getByText(/type the name of the service below/).closest('p')!;
      expect(warning.className).toContain('text-status-fail');
      expect(warning.className).not.toMatch(/red-\d/);
    });
  });

  describe('workspace drawer', () => {
    it('tokenises the header eyebrow, title, node badge and description', () => {
      render(<Harness />);
      drive('open-monitor');

      const eyebrow = screen.getByText('Service Monitor');
      expect(eyebrow.className).toContain('text-text-muted');

      const title = screen.getByRole('heading', { name: /immich/ });
      expect(title.className).toContain('text-text');
      expect(title.className).not.toMatch(/gray-\d/);

      const badge = screen.getByText('attic');
      expect(badge.className).toContain('bg-status-info/10');
      expect(badge.className).toContain('text-status-info');
      expect(badge.className).toContain('border-status-info/20');

      expect(screen.getByText('Photo library').className).toContain('text-text-muted');
      // Monitor mode renders the monitor, not the form.
      expect(screen.getByTestId('service-monitor').textContent).toBe('immich.service');
    });

    it('shows a muted loading state then the surface-2 edit body', async () => {
      let release: (r: Response) => void = () => {};
      fetchMock.mockReturnValue(new Promise<Response>(res => { release = res; }));

      render(<Harness />);
      drive('open-edit');

      // Loading branch — muted text token, spinner, no form yet.
      const loading = await screen.findByText(/Loading configuration/);
      expect(loading.className).toContain('text-text-muted');
      expect(loading.className).not.toMatch(/gray-\d/);
      expect(screen.queryByTestId('service-form')).toBeNull();
      // The node is non-Local, so the fetch is node-scoped.
      expect(fetchMock.mock.calls[0][0]).toBe('/api/services/immich.service?node=attic');

      await act(async () => {
        release(new Response(JSON.stringify({ kubeContent: 'k', yamlContent: 'y' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      });

      await screen.findByTestId('service-form');
      expect(screen.getByTestId('service-form').parentElement!.className).toContain('bg-surface-2');
      expect(screen.queryByText(/Loading configuration/)).toBeNull();
    });

    it('does not open the edit drawer for a non-kube service', () => {
      render(<Harness />);
      drive('open-edit-plain');
      expect(screen.queryByText('Edit Service')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
