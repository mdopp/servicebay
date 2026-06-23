import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('ui/Badge', () => {
  it('renders neutral by default', () => {
    render(<Badge>label</Badge>);
    const el = screen.getByText('label');
    expect(el.getAttribute('data-variant')).toBe('neutral');
    expect(el.className).toContain('rounded-chip');
  });

  it.each(['neutral', 'ok', 'warn', 'fail', 'info', 'accent'] as const)(
    'applies the %s variant via status/accent tokens (no raw color literals)',
    (variant) => {
      render(<Badge variant={variant}>v</Badge>);
      const el = screen.getByText('v');
      expect(el.getAttribute('data-variant')).toBe(variant);
      expect(el.className).not.toMatch(/green-\d|amber-\d|red-\d|blue-\d/);
    },
  );
});
