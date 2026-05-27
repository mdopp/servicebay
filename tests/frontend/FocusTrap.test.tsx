import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import FocusTrap from '@/components/FocusTrap';

// #1090 Phase 1 — pins the focus-trap contract:
// - mount focuses the first focusable child
// - Tab from the last focusable wraps to the first
// - Shift+Tab from the first wraps to the last
// - unmount restores focus to the previously-focused element

describe('FocusTrap', () => {
  it('focuses the first focusable child on mount', () => {
    render(
      <FocusTrap>
        <button>first</button>
        <button>second</button>
      </FocusTrap>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('Tab from the last focusable wraps back to the first', () => {
    render(
      <FocusTrap>
        <button>first</button>
        <button>last</button>
      </FocusTrap>,
    );
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last', () => {
    render(
      <FocusTrap>
        <button>first</button>
        <button>last</button>
      </FocusTrap>,
    );
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    first.focus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('non-Tab keys pass through (no preventDefault)', () => {
    render(
      <FocusTrap>
        <button>only</button>
      </FocusTrap>,
    );
    const button = screen.getByRole('button', { name: 'only' });
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('restores focus to the previously-focused element on unmount', () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const { unmount } = render(
      <FocusTrap>
        <button>inside</button>
      </FocusTrap>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'inside' }));

    unmount();
    expect(document.activeElement).toBe(outside);
    document.body.removeChild(outside);
  });

  it('active=false skips the trap (no focus capture, no key handling)', () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    render(
      <FocusTrap active={false}>
        <button>inside</button>
      </FocusTrap>,
    );

    // Mount did NOT steal focus.
    expect(document.activeElement).toBe(outside);
    document.body.removeChild(outside);
  });
});
