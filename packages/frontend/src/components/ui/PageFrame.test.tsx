import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageFrame, PAGE_FRAME_CLASS } from './PageFrame';

// #2548: one source of truth for a dashboard page's content width. These pin
// BOTH halves of the contract — the width it contributes, and the layout
// defaults it must NOT quietly impose on every page (the #2542 footgun, where
// migrating call sites onto a shared primitive inherited `justify-center`).

describe('ui/PageFrame', () => {
  it('is the page width: max-w-page, centred, full-width below the cap', () => {
    render(<PageFrame>body</PageFrame>);
    const el = screen.getByText('body');
    expect(el.className).toContain('max-w-page');
    expect(el.className).toContain('mx-auto');
    expect(el.className).toContain('w-full');
  });

  it('keeps the shell flex/height chain intact so a page`s h-full still resolves', () => {
    render(<PageFrame>body</PageFrame>);
    const el = screen.getByText('body');
    // <main> is a fixed-height flex column; without these the wrapper has no
    // definite height and every page rooted with `h-full` collapses.
    for (const cls of ['flex-1', 'min-h-0', 'min-w-0', 'flex', 'flex-col']) {
      expect(el.className).toContain(cls);
    }
  });

  it('imposes nothing else — no padding, scroll, spacing or alignment', () => {
    // Pages own their padding (PageHeader is full-bleed) and their scroll
    // region (<PageScroll>). A default here would silently restyle every page.
    expect(PAGE_FRAME_CLASS).not.toMatch(/\b(p|px|py|pt|pb|pl|pr)-/);
    expect(PAGE_FRAME_CLASS).not.toMatch(/overflow-/);
    expect(PAGE_FRAME_CLASS).not.toMatch(/space-[xy]-/);
    expect(PAGE_FRAME_CLASS).not.toMatch(/\b(items|justify|text)-/);
    expect(PAGE_FRAME_CLASS).not.toMatch(/\bgap-/);
  });

  it('merges a passed className without dropping the frame', () => {
    render(<PageFrame className="relative">body</PageFrame>);
    const el = screen.getByText('body');
    expect(el.className).toContain('relative');
    expect(el.className).toContain('max-w-page');
  });
});
