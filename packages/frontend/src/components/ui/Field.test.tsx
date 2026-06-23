import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './Field';

describe('ui/Field', () => {
  it('wires the label to the control via a generated id', () => {
    render(
      <Field label="Domain">
        {(props) => <input {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText('Domain');
    expect(input.getAttribute('id')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('renders help text linked via aria-describedby', () => {
    render(
      <Field label="Port" help="1-65535">
        {(props) => <input {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText('Port');
    const help = screen.getByText('1-65535');
    expect(input.getAttribute('aria-describedby')).toContain(help.getAttribute('id'));
  });

  it('announces an error and marks the control invalid (error overrides help)', () => {
    render(
      <Field label="Email" help="ignored" error="Required">
        {(props) => <input {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const err = screen.getByRole('alert');
    expect(err.textContent).toBe('Required');
    expect(input.getAttribute('aria-describedby')).toContain(err.getAttribute('id'));
    expect(screen.queryByText('ignored')).toBeNull();
  });

  it('shows a required marker', () => {
    render(
      <Field label="Name" required>
        {(props) => <input {...props} />}
      </Field>,
    );
    expect(screen.getByText('*')).toBeDefined();
  });
});
