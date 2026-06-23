import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import ManualServiceForm from './ManualServiceForm';
import { ToastProvider } from '@/providers/ToastProvider';

describe('ManualServiceForm — design-system tokens (#2100)', () => {
  it('uses token surfaces/borders, no raw bg-white / gray / blue literals', () => {
    const { container } = render(
      <ToastProvider>
        <ManualServiceForm />
      </ToastProvider>,
    );
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d|bg-blue-\d/);
    // form fields still rendered (function preserved)
    expect(screen.getByPlaceholderText('my-service')).toBeTruthy();
    expect(screen.getByPlaceholderText('nginx:latest')).toBeTruthy();
    expect(screen.getByText('Create Service')).toBeTruthy();
  });
});
