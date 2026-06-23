import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionHeading } from './SectionHeading';

describe('ui/SectionHeading', () => {
  it('renders an h2 by default with default tone', () => {
    render(<SectionHeading>Configuration</SectionHeading>);
    const h = screen.getByRole('heading', { name: 'Configuration', level: 2 });
    expect(h.className).toContain('text-text');
  });

  it('uses status-fail for the danger tone (Danger zone)', () => {
    render(<SectionHeading tone="danger">Danger zone</SectionHeading>);
    expect(screen.getByRole('heading', { name: 'Danger zone' }).className).toContain(
      'text-status-fail',
    );
  });

  it('honours the as prop and renders description + actions', () => {
    render(
      <SectionHeading as="h3" description="desc text" actions={<button>edit</button>}>
        Lifecycle
      </SectionHeading>,
    );
    expect(screen.getByRole('heading', { name: 'Lifecycle', level: 3 })).toBeDefined();
    expect(screen.getByText('desc text')).toBeDefined();
    expect(screen.getByRole('button', { name: 'edit' })).toBeDefined();
  });
});
