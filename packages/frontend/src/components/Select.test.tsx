import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Select, type SelectOption } from './Select';

const opts: SelectOption[] = [
  { label: 'Alpha', value: 'a', description: 'first', badge: 'NEW' },
  { label: 'Beta', value: 'b', description: 'second' },
  { label: 'Gamma', value: 'c', disabled: true },
];

describe('Select — design-system tokens + preserved API (#2100)', () => {
  it('uses token surfaces/borders, no raw bg-white / gray / indigo literals', () => {
    const { container } = render(<Select options={opts} value="a" onChange={() => {}} />);
    fireEvent.click(screen.getByText('Alpha')); // open panel so list chrome renders
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d|indigo/);
  });

  it('opens, filters via search, and calls onChange with the selected value (API preserved)', () => {
    const onChange = vi.fn();
    render(<Select options={opts} value={null} onChange={onChange} placeholder="Pick" />);
    fireEvent.click(screen.getByText('Pick'));
    // search box present (searchable default true)
    const search = screen.getByPlaceholderText('Search...');
    fireEvent.change(search, { target: { value: 'bet' } });
    expect(screen.queryByText('Alpha')).toBeNull();
    fireEvent.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('renders option badge + description and skips disabled options', () => {
    const onChange = vi.fn();
    render(<Select options={opts} value={null} onChange={onChange} searchable={false} />);
    fireEvent.click(screen.getByText('Select option'));
    expect(screen.getByText('NEW')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    fireEvent.click(screen.getByText('Gamma'));
    expect(onChange).not.toHaveBeenCalled(); // disabled
  });

  it('honours disabled prop (button does not open)', () => {
    render(<Select options={opts} value="a" onChange={() => {}} disabled />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.queryByPlaceholderText('Search...')).toBeNull();
  });
});
