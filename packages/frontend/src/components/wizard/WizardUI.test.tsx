/**
 * WizardUI — Button/Input primitive swap (no-raw-ui-primitive sweep).
 *
 * The wizard's local `Input` and `Button` style-variant wrappers implemented
 * themselves on a raw `<input>`/`<button>`; they now delegate to the shared
 * `Input`/`Button` primitives from `@/components/ui` (aliased `UIInput`/
 * `UIButton` to avoid colliding with these very component names) while
 * keeping their own className-driven look. This file had no test at all, so
 * the swap shipped with zero coverage — render all three exports and drive
 * the handlers each swapped element is wired to.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Info } from 'lucide-react';

import { Toggle, Input, Button } from './WizardUI';

describe('WizardUI — Button/Input primitive swap (#no-raw-ui-primitive)', () => {
  it('Input renders a real <input> and calls onChange with the typed value', () => {
    const onChange = vi.fn();
    render(<Input label="Name" value="" onChange={onChange} placeholder="Enter a name" />);

    const input = screen.getByPlaceholderText('Enter a name');
    expect(input.tagName).toBe('INPUT');
    fireEvent.change(input, { target: { value: 'my-service' } });
    expect(onChange).toHaveBeenCalledWith('my-service');
  });

  it('Input shows the hint or the error line', () => {
    const { rerender } = render(<Input label="Name" value="" onChange={vi.fn()} hint="lowercase only" />);
    expect(screen.getByText('lowercase only')).toBeTruthy();

    rerender(<Input label="Name" value="" onChange={vi.fn()} hint="lowercase only" error="required" />);
    expect(screen.getByText('required')).toBeTruthy();
    expect(screen.queryByText('lowercase only')).toBeNull();
  });

  it('Button renders a real <button> and calls onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Continue</Button>);

    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it('Button honours the disabled prop', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Continue</Button>);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Toggle renders checked/unchecked state and calls onChange with the flipped value', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Toggle checked={false} onChange={onChange} icon={Info} color="text-accent" title="Auto-update" desc="Keep it current" />,
    );
    fireEvent.click(screen.getByText('Auto-update'));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(
      <Toggle checked={true} onChange={onChange} icon={Info} color="text-accent" title="Auto-update" desc="Keep it current" />,
    );
    fireEvent.click(screen.getByText('Auto-update'));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
