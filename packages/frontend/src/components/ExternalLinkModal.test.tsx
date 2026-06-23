import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ExternalLinkModal from './ExternalLinkModal';

function baseForm(over: Record<string, unknown> = {}) {
  return { name: '', url: '', description: '', monitor: false, ...over } as never;
}

describe('ExternalLinkModal — design-system tokens (#2100)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ExternalLinkModal isOpen={false} onClose={() => {}} onSave={() => {}} isEditing={false} form={baseForm()} setForm={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('uses token surfaces/borders, no raw bg-white / gray / blue literals', () => {
    const { container } = render(
      <ExternalLinkModal isOpen onClose={() => {}} onSave={() => {}} isEditing={false} form={baseForm({ name: 'X', url: 'http://a.b' })} setForm={() => {}} />,
    );
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d|bg-blue-\d|border-red-\d|text-red-\d/);
  });

  it('disables save when name/url invalid and enables when both valid (validation preserved)', () => {
    const { rerender } = render(
      <ExternalLinkModal isOpen onClose={() => {}} onSave={() => {}} isEditing={false} form={baseForm({ name: '', url: 'not-a-url' })} setForm={() => {}} />,
    );
    expect((screen.getByText('Add Link').closest('button') as HTMLButtonElement).disabled).toBe(true);
    // invalid URL message shown
    expect(screen.getByRole('alert').textContent).toMatch(/http/);

    rerender(
      <ExternalLinkModal isOpen onClose={() => {}} onSave={() => {}} isEditing={false} form={baseForm({ name: 'HA', url: 'http://ha.local' })} setForm={() => {}} />,
    );
    expect((screen.getByText('Add Link').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('fires onClose and onSave (modal behaviour preserved)', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(
      <ExternalLinkModal isOpen onClose={onClose} onSave={onSave} isEditing form={baseForm({ name: 'HA', url: 'http://ha.local' })} setForm={() => {}} />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save Changes'));
    expect(onSave).toHaveBeenCalled();
  });
});
