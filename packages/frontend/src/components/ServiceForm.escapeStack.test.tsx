/**
 * ServiceForm — Escape unwinds one overlay layer at a time (#2775).
 *
 * The rename modal's `useEscapeKey` used to register a plain `window` keydown
 * listener (the default `topMostOnly=false` path), so a single Escape fired
 * both a stacked `ConfirmModal`'s callback AND the rename modal's — one press
 * tore down both layers. The call site now joins the shared overlay stack, so
 * each press pops exactly one layer. Follow-up to #2774.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
}));
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNodes: vi.fn(async () => []),
}));
// Keep the history panel out of the render.
vi.mock('./HistoryViewer', () => ({ __esModule: true, default: () => <div /> }));

import ServiceForm from './ServiceForm';
import ConfirmModal from './ConfirmModal';

/** The form plus a confirmation the surrounding page can stack over it. */
function Harness() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <ServiceForm
        isEdit
        initialData={{
          name: 'my-service',
          yamlFileName: 'my-service.yml',
          kubeContent: '',
          yamlContent: '',
        }}
      />
      <button onClick={() => setConfirmOpen(true)}>drive:open-confirm</button>
      <ConfirmModal
        isOpen={confirmOpen}
        title="Discard changes"
        message="Are you sure?"
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

const pressEscape = () => fireEvent.keyDown(window, { key: 'Escape' });
const renameHeading = () => screen.queryByRole('heading', { name: /rename service/i });

describe('ServiceForm — Escape pops one overlay layer at a time (#2775)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes only the stacked confirmation on the first Escape, the rename modal on the second', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByTitle('Rename Service & Files'));
    expect(renameHeading()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'drive:open-confirm' }));
    expect(screen.getByRole('heading', { name: 'Discard changes' })).toBeTruthy();

    // First Escape: the confirmation backs out, the rename modal underneath survives.
    pressEscape();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Discard changes' })).toBeNull(),
    );
    expect(renameHeading()).toBeTruthy();

    // Second Escape: now the rename modal closes.
    pressEscape();
    await waitFor(() => expect(renameHeading()).toBeNull());
  });

  it('closes the rename modal on a single Escape when no confirmation is open', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByTitle('Rename Service & Files'));
    expect(renameHeading()).toBeTruthy();

    pressEscape();
    await waitFor(() => expect(renameHeading()).toBeNull());
  });
});
