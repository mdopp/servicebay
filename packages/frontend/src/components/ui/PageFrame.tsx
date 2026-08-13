import { cn } from './cn';

/**
 * <PageFrame> — the ONE source of truth for a dashboard page's content width (#2548).
 *
 * The shell (`app/(dashboard)/layout.tsx`) used to impose no width at all, so
 * every page invented its own: Home was `max-w-5xl mx-auto`, Containers was
 * `w-full`, the file viewer was `max-w-7xl mx-auto`. Navigating between them
 * moved the content sideways, because each page centred its own column at a
 * different width. The frame is a property of the *shell*, not of the page.
 *
 * So the layout renders exactly one <PageFrame> around `children`. A new page
 * gets the right width by existing — there is nothing to remember and nothing
 * to import; a page that sets its own `max-w-* mx-auto` at the root is now a
 * bug (guarded by `tests/frontend/page-frame.test.tsx`).
 *
 * What it deliberately does NOT do (the #2542 lesson — a shared wrapper that
 * quietly imposes layout defaults is how the sidebar got `justify-center`):
 *   - no padding: `PageHeader` is full-bleed with its own border, and every
 *     page pads its own scroll region;
 *   - no `overflow-*`: pages own their scroll region (see <PageScroll>);
 *   - no `space-y-*` / alignment: it never touches how children are laid out.
 * It contributes width and the flex/height chain only — nothing visible.
 *
 * The height classes are load-bearing: `<main>` is a fixed-height flex column,
 * and pages root themselves with `h-full`. Inserting a wrapper without
 * `flex-1 min-h-0 flex flex-col` would leave that `h-full` resolving against an
 * auto-height box and collapse (or unbound) every page.
 *
 * NOT a page-frame concern, and intentionally untouched: `max-w-*` **inside** a
 * page — a search input, a drawer/modal, an empty-state paragraph, a
 * single-column form's reading measure. Those bound one element, not the page,
 * and a left-aligned one cannot shift the content's left edge.
 */

/**
 * The canonical page-frame classes. Exported so a test can pin the width in one
 * place; render <PageFrame> rather than pasting this string into a page.
 */
export const PAGE_FRAME_CLASS = 'w-full max-w-page mx-auto flex-1 min-w-0 min-h-0 flex flex-col';

export function PageFrame({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(PAGE_FRAME_CLASS, className)} {...rest} />;
}
