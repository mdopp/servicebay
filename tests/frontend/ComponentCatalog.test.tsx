import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// #2354 — the /dev/components discovery route. We assert it renders WITHOUT
// crashing and lists EVERY @/components/ui primitive, so the gallery can't
// silently drop a primitive when the barrel grows. `notFound()` is only hit in
// a production build (NODE_ENV==='production'); under vitest we're in 'test',
// so the full gallery renders. We mock it defensively so an accidental call
// would throw loudly rather than render an empty tree.
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound() should not be reached in the test environment');
  }),
}));

import ComponentCatalogPage from '@/app/(dashboard)/dev/components/page';

// The barrel is the source of truth for "which primitives exist". These are
// the catalog-entry ids the page must render one gallery section for.
const EXPECTED_ENTRIES = [
  'button',
  'card',
  'badge',
  'status-dot',
  'section-heading',
  'field',
  'data-table',
  'page-scroll',
];

describe('/dev/components — component catalog', () => {
  it('renders without crashing and shows the catalog heading', () => {
    render(<ComponentCatalogPage />);
    expect(screen.getByRole('heading', { level: 1, name: /component catalog/i })).toBeTruthy();
  });

  it('renders a gallery entry for every ui primitive', () => {
    const { container } = render(<ComponentCatalogPage />);
    for (const id of EXPECTED_ENTRIES) {
      expect(
        container.querySelector(`[data-catalog-entry="${id}"]`),
        `expected a gallery entry for "${id}"`,
      ).not.toBeNull();
    }
    // Exactly one section per primitive — no stray/duplicated entries.
    expect(container.querySelectorAll('[data-catalog-entry]').length).toBe(EXPECTED_ENTRIES.length);
  });

  it('renders concrete specimens of the primitives (Button, Badge, StatusDot)', () => {
    render(<ComponentCatalogPage />);
    // Every Button variant renders its size labels; at least the primary set.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    // Badge variants render their own name as text.
    expect(screen.getByText('accent')).toBeTruthy();
    // StatusDot uses role="status" for its accessible announcement.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });
});
