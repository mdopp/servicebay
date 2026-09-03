/**
 * HealthDashboard — Escape unwinds one overlay layer at a time (#2775).
 *
 * The dashboard's own `useEscapeKey` used to register a plain `window` keydown
 * listener (the default `topMostOnly=false` path), so a single Escape fired
 * both the delete `ConfirmModal`'s stack callback AND the dashboard's own
 * handler — one press tore down the confirmation and the history drawer
 * underneath it. The call site now joins the shared overlay stack, so each
 * press pops exactly one layer. Follow-up to #2774.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const check = {
  id: 'c1',
  name: 'API',
  type: 'http',
  target: 'https://example.com',
  interval: 60,
  enabled: true,
  status: 'ok',
};

vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
  ToastType: {},
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNodes: vi.fn(async () => []),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/status',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// Stand-in for the checks table: exposes the two callbacks this test drives
// (open the history drawer, then open the delete confirmation on top of it).
vi.mock('@/components/HealthChecks', () => ({
  __esModule: true,
  default: ({
    handleViewHistory,
    handleOpenDeleteModal,
  }: {
    handleViewHistory: (c: typeof check) => void;
    handleOpenDeleteModal: (id: string) => void;
  }) => (
    <div data-testid="health-checks">
      <button onClick={() => handleViewHistory(check)}>drive:view-history</button>
      <button onClick={() => handleOpenDeleteModal(check.id)}>drive:delete-check</button>
    </div>
  ),
}));
vi.mock('@/components/LogViewer', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/components/DiagnoseProbeList', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/dashboards/ContainersDashboard', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/dashboards/SystemInfoDashboard', () => ({ SystemInfoContent: () => <div /> }));

import HealthDashboard from './HealthDashboard';

const pressEscape = () => fireEvent.keyDown(window, { key: 'Escape' });

describe('HealthDashboard — Escape pops one overlay layer at a time (#2775)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
    );
  });

  it('closes only the delete confirmation on the first Escape, the drawer on the second', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'drive:view-history' }));
    await waitFor(() => expect(screen.getByText('History Drawer')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'drive:delete-check' }));
    expect(screen.getByRole('heading', { name: 'Delete Check' })).toBeTruthy();

    // First Escape: the confirmation backs out, the drawer underneath survives.
    pressEscape();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete Check' })).toBeNull());
    expect(screen.getByText('History Drawer')).toBeTruthy();

    // Second Escape: now the drawer closes.
    pressEscape();
    await waitFor(() => expect(screen.queryByText('History Drawer')).toBeNull());
  });

  it('closes the drawer on a single Escape when no confirmation is open', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'drive:view-history' }));
    await waitFor(() => expect(screen.getByText('History Drawer')).toBeTruthy());

    pressEscape();
    await waitFor(() => expect(screen.queryByText('History Drawer')).toBeNull());
  });
});
