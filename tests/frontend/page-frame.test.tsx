/**
 * Page-frame guard (#2548, child of the #2546 shell epic).
 *
 * Symptom the operator reported: navigating Home → Services → Status → Network
 * made the content jump sideways, because Home centred itself at `max-w-5xl`
 * while every other page ran full-bleed and the dashboard layout imposed no
 * width at all.
 *
 * The fix is structural: the layout wraps `children` in exactly one
 * <PageFrame>, so a page gets the right width by existing. These tests pin that
 * — one asserts the layout really renders the frame around the page, the other
 * makes it impossible for a NEW page to silently opt out by centring a page
 * width of its own.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/components/Sidebar', () => ({ default: () => <div /> }));
vi.mock('@/components/MobileNav', () => ({
  MobileTopBar: () => <div />,
  MobileBottomBar: () => <div />,
}));
vi.mock('@/components/OnboardingWizard', () => ({ default: () => null }));
vi.mock('@/components/RestoreStatusBanner', () => ({ default: () => null }));
vi.mock('@/components/CoreHealthBanner', () => ({ default: () => null }));
vi.mock('@/components/OfflineBanner', () => ({ default: () => null }));

import DashboardLayout from '@/app/(dashboard)/layout';

const FRONTEND_SRC = path.resolve(__dirname, '../../packages/frontend/src');

/** Every route root under the dashboard shell + the dashboards they render. */
function pageSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string, match: (f: string) => boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, match);
      else if (match(entry.name)) out.push({ file: full, source: readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(FRONTEND_SRC, 'app', '(dashboard)'), f => f === 'page.tsx' || f === 'layout.tsx');
  walk(path.join(FRONTEND_SRC, 'dashboards'), f => f.endsWith('.tsx') && !f.includes('.test.'));
  return out;
}

describe('dashboard page frame (#2548)', () => {
  it('the dashboard layout wraps the page in the shared frame', () => {
    render(<DashboardLayout><p>page content</p></DashboardLayout>);
    const frame = screen.getByText('page content').parentElement;
    expect(frame?.className).toContain('max-w-page');
    expect(frame?.className).toContain('mx-auto');
    // …and it is inside <main>, so the shell chrome itself stays full-bleed.
    expect(frame?.parentElement?.tagName).toBe('MAIN');
  });

  it('the width lives in ONE place — no page hardcodes max-w-page', () => {
    for (const { file, source } of pageSources()) {
      expect(source, `${file} must not re-declare the page width`).not.toContain('max-w-page');
    }
  });

  it('no page centres a page width of its own', () => {
    // A *page frame* is a centred container wide enough to be the page: that is
    // what shifts the content's left edge from one route to the next. Narrow
    // in-section measures (a `max-w-md` empty-state paragraph, a form column, a
    // search input) are deliberate and stay — they bound one element, and a
    // left-aligned one cannot move the page.
    const pageWidth = /class(?:Name)?="[^"]*\bmax-w-(?:4xl|5xl|6xl|7xl|page|screen-[a-z0-9]+)\b[^"]*\bmx-auto\b|class(?:Name)?="[^"]*\bmx-auto\b[^"]*\bmax-w-(?:4xl|5xl|6xl|7xl|page|screen-[a-z0-9]+)\b/;
    for (const { file, source } of pageSources()) {
      expect(
        pageWidth.test(source),
        `${file} centres its own page width — delete it; the width comes from <PageFrame> in app/(dashboard)/layout.tsx`,
      ).toBe(false);
    }
  });
});
