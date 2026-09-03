/**
 * Container Actions + its Delete confirmation — Escape unwinds one layer (#2774).
 *
 * `ConfirmModal` used to register a plain window keydown listener (the default
 * `topMostOnly=false` path of `useEscapeKey`), so a single Escape fired both the
 * modal's own listener AND the overlay stack's top callback — which was still the
 * parent panel's `closeActions`. One press tore down both layers. The modal now
 * joins the overlay stack, so each press pops exactly one layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { useContainerActions, type ContainerActionTarget } from './useContainerActions';

const addToast = vi.fn(() => 'toast-1');
const updateToast = vi.fn();
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast, updateToast }),
}));

const container: ContainerActionTarget = {
  id: 'abcdef0123456789',
  name: 'media-jellyfin',
  nodeName: 'Local',
};

/** Mounts the hook and exposes `openActions` as a plain button, like a dashboard does. */
function Harness() {
  const actions = useContainerActions();
  return (
    <>
      <button onClick={() => actions.openActions(container)}>drive:open-actions</button>
      {actions.overlay}
    </>
  );
}

const click = (name: string | RegExp): void => {
  act(() => {
    screen.getByRole('button', { name }).click();
  });
};

const pressEscape = (): void => {
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' });
  });
};

describe('useContainerActions — Escape unwinds one overlay layer at a time (#2774)', () => {
  beforeEach(() => {
    addToast.mockClear();
    updateToast.mockClear();
  });

  it('closes only the delete confirmation on the first Escape, the panel on the second', () => {
    render(<Harness />);

    click('drive:open-actions');
    expect(screen.getByText('Container Actions')).toBeTruthy();

    click(/Delete Container/);
    expect(screen.getByText('Delete container')).toBeTruthy();

    // First Escape: the confirmation backs out, the panel underneath survives.
    pressEscape();
    expect(screen.queryByText('Delete container')).toBeNull();
    expect(screen.getByText('Container Actions')).toBeTruthy();

    // Second Escape: now the panel closes.
    pressEscape();
    expect(screen.queryByText('Container Actions')).toBeNull();
  });

  it('closes the panel on a single Escape when no confirmation is open', () => {
    render(<Harness />);

    click('drive:open-actions');
    expect(screen.getByText('Container Actions')).toBeTruthy();

    pressEscape();
    expect(screen.queryByText('Container Actions')).toBeNull();
  });
});
