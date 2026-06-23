import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusDot } from './StatusDot';

describe('ui/StatusDot', () => {
  it.each([
    ['ok', 'OK', 'bg-status-ok'],
    ['warn', 'Warning', 'bg-status-warn'],
    ['fail', 'Failed', 'bg-status-fail'],
    ['unknown', 'Unknown', 'bg-text-subtle'],
  ] as const)('renders %s with an accessible label and token color', (state, label, color) => {
    const { container } = render(<StatusDot state={state} />);
    const root = screen.getByRole('status');
    expect(root.getAttribute('data-state')).toBe(state);
    // default label is screen-reader-only but present for a11y
    expect(screen.getByText(label)).toBeDefined();
    expect(container.querySelector(`.${color.replace('/', '\\/')}`)).not.toBeNull();
  });

  it('shows the label inline when showLabel is set', () => {
    render(<StatusDot state="ok" label="Healthy" showLabel />);
    const text = screen.getByText('Healthy');
    expect(text.className).not.toContain('sr-only');
  });
});
