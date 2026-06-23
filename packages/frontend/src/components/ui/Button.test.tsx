import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('ui/Button', () => {
  it('renders its children and defaults to type=button (no accidental submit)', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('data-variant')).toBe('primary');
  });

  it.each(['primary', 'secondary', 'ghost', 'danger'] as const)(
    'applies the %s variant token classes',
    (variant) => {
      render(<Button variant={variant}>x</Button>);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('data-variant')).toBe(variant);
      // every variant resolves through semantic tokens, never raw color literals
      expect(btn.className).not.toMatch(/blue-\d|gray-\d|red-\d/);
    },
  );

  it.each(['sm', 'md'] as const)('applies the %s size', (size) => {
    render(<Button size={size}>x</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain(size === 'sm' ? 'h-8' : 'h-10');
  });

  it('forwards onClick and respects disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Button onClick={onClick} disabled>go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1); // disabled blocks the second click
  });

  it('honours an explicit submit type', () => {
    render(<Button type="submit">submit</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });
});
