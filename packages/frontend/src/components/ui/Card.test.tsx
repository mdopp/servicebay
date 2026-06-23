import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, Panel } from './Card';

describe('ui/Card', () => {
  it('renders children on a token surface', () => {
    render(<Card>body</Card>);
    const el = screen.getByText('body');
    expect(el.className).toContain('bg-surface');
    expect(el.className).toContain('border-border');
    expect(el.className).toContain('rounded-card');
  });

  it('applies the padding scale and supports padding=none', () => {
    const { rerender } = render(<Card padding="lg">x</Card>);
    expect(screen.getByText('x').className).toContain('p-space-5');
    rerender(<Card padding="none">x</Card>);
    expect(screen.getByText('x').className).not.toMatch(/p-space-/);
  });
});

describe('ui/Panel', () => {
  it('renders a header with title + actions and a divided body', () => {
    render(
      <Panel title="Lifecycle" actions={<button>act</button>}>
        content
      </Panel>,
    );
    expect(screen.getByRole('heading', { name: 'Lifecycle' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'act' })).toBeDefined();
    expect(screen.getByText('content')).toBeDefined();
  });

  it('omits the header when no title/actions are given', () => {
    render(<Panel>just body</Panel>);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('just body')).toBeDefined();
  });
});
