import { cn } from './cn';

/**
 * <PageScroll> — the ONE canonical scrollable page/content pattern (#2077, epic #2071).
 *
 * The dashboard shell (`app/(dashboard)/layout.tsx`) is a fixed-height flex
 * column whose `<main>` is `overflow-hidden` — so a page that simply stacks
 * content overflows the viewport with **no scrollbar** and clips at the bottom
 * (operator bug: "Settings zu groß, keine Scrollbar"). The audit found this is
 * re-invented inconsistently across pages (82× overflow-hidden vs 44×
 * overflow-y-auto): some pages get `h-full overflow-y-auto`, some get nothing.
 *
 * The fix is a single flex-chain rule, captured here so pages don't re-author it:
 *
 *   - the page root fills the shell and is a flex column (`h-full flex flex-col`);
 *   - the **scrollable content region is `min-h-0 overflow-y-auto`** — `min-h-0`
 *     is the load-bearing part: a flex child defaults to `min-height:auto`, which
 *     refuses to shrink below its content and so never produces a scrollbar.
 *
 * Two pieces so a page can keep a sticky/non-scrolling header (e.g. a back link
 * + tab bar) above the scroll region:
 *
 *   <PageScroll>                  ← single scroll region for the whole page
 *     …content…
 *   </PageScroll>
 *
 *   <PageShell>                   ← flex-column shell; put a fixed header, then
 *     <header/>                     a <PageScrollRegion> for the scrolling body
 *     <PageScrollRegion>…</…>
 *   </PageShell>
 */

export interface PageScrollProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Vertical rhythm between direct children of the scroll region. */
  spacing?: 'none' | 'sm' | 'md' | 'lg';
}

const spacings: Record<NonNullable<PageScrollProps['spacing']>, string> = {
  none: '',
  sm: 'space-y-3',
  md: 'space-y-4',
  lg: 'space-y-6',
};

/**
 * The whole page is one scroll region. Fills the shell, scrolls its overflow.
 * Use when there is no part of the page that must stay pinned while scrolling.
 */
export function PageScroll({ spacing = 'lg', className, ...rest }: PageScrollProps) {
  return (
    <div
      className={cn(
        'h-full min-h-0 overflow-y-auto',
        spacings[spacing],
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A flex-column page shell. Pair a fixed (non-scrolling) header with a
 * <PageScrollRegion> for the body, so the header stays put while the body scrolls.
 */
export function PageShell({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('h-full min-h-0 flex flex-col', className)} {...rest} />;
}

/**
 * The scrolling body inside a <PageShell>. `min-h-0` lets the flex child shrink
 * below its content so `overflow-y-auto` actually produces a scrollbar.
 */
export function PageScrollRegion({
  spacing = 'lg',
  className,
  ...rest
}: PageScrollProps) {
  return (
    <div
      className={cn(
        'flex-1 min-h-0 overflow-y-auto',
        spacings[spacing],
        className,
      )}
      {...rest}
    />
  );
}
