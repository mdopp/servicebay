/**
 * ServiceForm — rename modal Escape-to-close (#2188).
 *
 * The rename-service modal now closes on Escape like every other modal in
 * the app (ConfirmModal etc.), via the shared `useEscapeKey` hook. These
 * tests assert Escape dismisses the modal, guarded so it can't dismiss
 * while a rename request is in flight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
}));
vi.mock('@/app/actions/system', () => ({ getNodes: () => Promise.resolve([]) }));
// Keep the history panel out of the render.
vi.mock('./HistoryViewer', () => ({ __esModule: true, default: () => <div /> }));

import ServiceForm from './ServiceForm';

function openRenameModal() {
  render(
    <ServiceForm
      isEdit
      initialData={{
        name: 'my-service',
        yamlFileName: 'my-service.yml',
        kubeContent: '',
        yamlContent: '',
      }}
    />,
  );
  fireEvent.click(screen.getByTitle('Rename Service & Files'));
  return screen.getByRole('heading', { name: /rename service/i });
}

describe('ServiceForm — rename modal Escape-to-close (#2188)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes the rename modal when Escape is pressed', async () => {
    openRenameModal();
    expect(screen.getByRole('heading', { name: /rename service/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /rename service/i })).toBeNull(),
    );
  });

  it('does not close the modal while a rename request is in flight', async () => {
    // A rename POST that never resolves — keeps isRenaming latched true.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    openRenameModal();
    // Trigger the rename (button enabled once newServiceName is set, which the
    // open-handler seeds with the current name).
    fireEvent.click(screen.getByRole('button', { name: 'Rename Service' }));

    await waitFor(() => expect(screen.getByText('Renaming...')).toBeTruthy());

    // Escape must be ignored while the request is in flight.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: /rename service/i })).toBeTruthy();
  });
});
