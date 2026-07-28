/**
 * RequestAccessButton — the /portal CTA. After #2405 the modal body lives
 * in RequestAccessDialog (so /portal/requests can render it pre-opened);
 * these tests pin that the button's own behaviour is unchanged: closed by
 * default, opens on click, closes again on Cancel.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RequestAccessButton from './RequestAccessButton';

describe('RequestAccessButton', () => {
  it('renders no form until the button is clicked', () => {
    render(<RequestAccessButton />);
    expect(screen.getByRole('button', { name: /have an account/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send request/i })).toBeNull();
  });

  it('opens the request-access form on click', () => {
    render(<RequestAccessButton />);
    fireEvent.click(screen.getByRole('button', { name: /have an account/i }));
    expect(screen.getByRole('heading', { name: /Request Access/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send request/i })).toBeTruthy();
  });

  it('closes again on Cancel', () => {
    render(<RequestAccessButton />);
    fireEvent.click(screen.getByRole('button', { name: /have an account/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByRole('button', { name: /Send request/i })).toBeNull();
  });
});
