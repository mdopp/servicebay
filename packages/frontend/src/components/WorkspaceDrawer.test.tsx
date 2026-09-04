import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkspaceDrawer from './WorkspaceDrawer';

describe('WorkspaceDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <WorkspaceDrawer isOpen={false} onClose={vi.fn()} header="Header">
        Body
      </WorkspaceDrawer>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('the close control is a Button primitive that calls onClose', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceDrawer isOpen onClose={onClose} header="Header">
        Body
      </WorkspaceDrawer>,
    );

    const closeBtn = screen.getByRole('button', { name: 'Close drawer' });
    expect(closeBtn.tagName).toBe('BUTTON');
    expect(closeBtn.getAttribute('data-variant')).toBe('ghost');

    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honours a custom closeAriaLabel', () => {
    render(
      <WorkspaceDrawer isOpen onClose={vi.fn()} header="Header" closeAriaLabel="Close logs">
        Body
      </WorkspaceDrawer>,
    );
    expect(screen.getByRole('button', { name: 'Close logs' })).toBeTruthy();
  });
});
