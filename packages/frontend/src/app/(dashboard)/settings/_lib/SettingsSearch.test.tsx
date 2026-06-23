import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SearchHit } from './ia';
import SettingsSearch from './SettingsSearch';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Deterministic hit set so the test asserts chrome + behavior, not the index.
const HITS: SearchHit[] = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { group: { id: 'general', label: 'General' } as any, entry: { id: 'name', label: 'Server name' } as any, href: '/settings/general#name' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { group: { id: 'access', label: 'Access' } as any, entry: { id: 'portal', label: 'Portal access' } as any, href: '/settings/access#portal' },
];
vi.mock('./ia', () => ({
  searchSettings: (q: string) => (q.trim() ? HITS : []),
}));

describe('SettingsSearch — design-system migration (#2100 ds-migrate-shell)', () => {
  beforeEach(() => pushMock.mockClear());

  it('input surface uses semantic tokens, no raw gray/blue/white literals', () => {
    render(<SettingsSearch />);
    const input = screen.getByLabelText('Search settings') as HTMLInputElement;
    expect(input.className).toContain('border-border');
    expect(input.className).toContain('bg-surface-2');
    expect(input.className).toContain('focus:ring-accent');
    expect(input.className).not.toMatch(/gray-\d|bg-white|dark:bg-gray|blue-\d/);
  });

  it('filters results as you type and shows them on a token surface', () => {
    render(<SettingsSearch />);
    const input = screen.getByLabelText('Search settings');
    fireEvent.change(input, { target: { value: 'server' } });

    // Results render (filtering preserved).
    const hit = screen.getByText('Server name');
    expect(hit).toBeDefined();

    // The dropdown container is a token surface, not bg-white/dark:bg-gray-800.
    const dropdown = hit.closest('div.absolute')!;
    expect(dropdown.className).toContain('bg-surface');
    expect(dropdown.className).toContain('border-border');
    expect(dropdown.className).not.toMatch(/bg-white|dark:bg-gray|gray-\d/);
  });

  it('highlights the active result with accent tokens', () => {
    render(<SettingsSearch />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'a' } });
    // First hit is active by default (activeIndex 0).
    const activeBtn = screen.getByText('Server name').closest('button')!;
    expect(activeBtn.className).toContain('bg-accent/10');
    expect(activeBtn.className).toContain('text-accent');
  });

  it('Enter on the active result navigates to its href (behavior preserved)', () => {
    render(<SettingsSearch />);
    const input = screen.getByLabelText('Search settings');
    fireEvent.change(input, { target: { value: 'server' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(pushMock).toHaveBeenCalledWith('/settings/general#name');
  });
});
