import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// #2077 regression guard: the per-service Operate page MUST own a scroll region,
// because the dashboard <main> (app/(dashboard)/layout.tsx) is overflow-hidden.
// Without it, an overlong tab (the operator hit it on Settings) clips at the
// bottom with no scrollbar. We assert the rendered page root carries the
// canonical PageScroll chain (min-h-0 + overflow-y-auto) — the exact classes
// that the load-bearing fix depends on.

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

// Render the loading state — it still mounts the PageScroll root, which is the
// only thing we need to assert, and avoids constructing a full ServiceViewModel.
vi.mock('../../../settings/services/_lib/useOperateServices', () => ({
  useOperateService: () => ({ service: null, loading: true }),
}));

import OperatePage from './OperatePage';

describe('OperatePage scroll container (#2077)', () => {
  it('renders a single canonical scroll region (min-h-0 + overflow-y-auto)', () => {
    const { container } = render(<OperatePage name="immich" />);
    const scrollers = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      el =>
        el.className.includes('min-h-0') &&
        el.className.includes('overflow-y-auto'),
    );
    expect(scrollers.length).toBeGreaterThanOrEqual(1);
    // and it fills the shell so it can scroll inside the overflow-hidden <main>
    expect(scrollers[0].className).toContain('h-full');
  });
});
