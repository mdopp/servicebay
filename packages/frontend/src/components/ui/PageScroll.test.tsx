import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageScroll, PageShell, PageScrollRegion } from './PageScroll';

// The whole point of #2077: the canonical scroll region must carry the
// load-bearing flex-chain classes — `min-h-0` (so a flex child can shrink below
// its content) AND `overflow-y-auto` (so the shrunk region produces a scrollbar).
// Without `min-h-0` a flex child defaults to min-height:auto and never scrolls —
// that's the operator's "Settings zu groß, keine Scrollbar" bug.

describe('ui/PageScroll', () => {
  it('is a self-contained scroll region: h-full + min-h-0 + overflow-y-auto', () => {
    render(<PageScroll>body</PageScroll>);
    const el = screen.getByText('body');
    expect(el.className).toContain('h-full');
    expect(el.className).toContain('min-h-0');
    expect(el.className).toContain('overflow-y-auto');
    // never clips: must NOT pin the body height with an overflow-hidden
    expect(el.className).not.toContain('overflow-hidden');
  });

  it('applies the spacing scale and merges a passed className', () => {
    const { rerender } = render(<PageScroll spacing="md" className="pb-8">x</PageScroll>);
    let el = screen.getByText('x');
    expect(el.className).toContain('space-y-4');
    expect(el.className).toContain('pb-8');
    rerender(<PageScroll spacing="none">x</PageScroll>);
    el = screen.getByText('x');
    expect(el.className).not.toMatch(/space-y-/);
  });
});

describe('ui/PageShell + PageScrollRegion (fixed header + scrolling body)', () => {
  it('PageShell is a flex column that fills the shell', () => {
    render(<PageShell>shell</PageShell>);
    const el = screen.getByText('shell');
    expect(el.className).toContain('h-full');
    expect(el.className).toContain('min-h-0');
    expect(el.className).toContain('flex');
    expect(el.className).toContain('flex-col');
  });

  it('PageScrollRegion is the scrolling flex child: flex-1 + min-h-0 + overflow-y-auto', () => {
    render(<PageScrollRegion>region</PageScrollRegion>);
    const el = screen.getByText('region');
    expect(el.className).toContain('flex-1');
    expect(el.className).toContain('min-h-0');
    expect(el.className).toContain('overflow-y-auto');
  });
});
