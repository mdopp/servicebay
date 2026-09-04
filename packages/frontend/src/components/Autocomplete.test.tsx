import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Autocomplete } from './Autocomplete';

describe('Autocomplete', () => {
  it('renders the shared Input primitive and calls onChange with the typed value', () => {
    const onChange = vi.fn();
    render(
      <Autocomplete
        options={['alpha', 'beta', 'gamma']}
        value=""
        onChange={onChange}
        placeholder="Search…"
      />,
    );

    const input = screen.getByPlaceholderText('Search…');
    expect(input.tagName).toBe('INPUT');

    fireEvent.change(input, { target: { value: 'al' } });
    expect(onChange).toHaveBeenCalledWith('al');
    expect(screen.getByText('alpha')).toBeDefined();
  });

  it('disables the input and shows the loading placeholder while loading', () => {
    render(
      <Autocomplete
        options={['alpha']}
        value=""
        onChange={vi.fn()}
        placeholder="Search…"
        loading
      />,
    );

    const input = screen.getByPlaceholderText('Loading...') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('selecting an option calls onChange with the option and closes the list', () => {
    const onChange = vi.fn();
    render(
      <Autocomplete
        options={['alpha', 'beta']}
        value=""
        onChange={onChange}
        placeholder="Search…"
      />,
    );

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.focus(input);
    fireEvent.click(screen.getByText('beta'));

    expect(onChange).toHaveBeenCalledWith('beta');
    expect(screen.queryByText('alpha')).toBeNull();
  });
});
