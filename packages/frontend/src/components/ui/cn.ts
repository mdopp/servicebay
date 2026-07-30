import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Class-name joiner for the design-system primitives (#2071), with Tailwind
 * conflict resolution (#2484).
 *
 * WHY tailwind-merge and not a plain string join: every primitive composes its
 * own defaults with the caller's `className`
 * (`cn(base, variants[v], sizes[s], className)`). A plain join emits BOTH the
 * default and the override — e.g. Button's `h-10 px-space-4` next to a caller's
 * `h-auto px-6` — and which one paints is then decided by the order Tailwind
 * happens to emit those rules into the stylesheet, not by the caller's intent.
 * That silently regressed five migrations in one session (#2479, #2482, #2483,
 * #2487, #2490): a raw `<button>` with its own geometry became a `<Button>` and
 * quietly rendered at the primitive's default size. tailwind-merge drops the
 * earlier class of a conflicting pair, so the LAST one wins deterministically —
 * which is exactly "the caller's `className` overrides the primitive's default".
 *
 * The `extend` below teaches it this repo's custom `@theme` namespaces from
 * `app/globals.css`; without them `px-space-4` and `px-6` are not recognized as
 * the same utility group and both survive the merge (the original bug):
 *  - `--spacing-space-<n>` → `p-space-4`, `gap-space-2`, `mt-space-1`, …
 *  - `--radius-{chip,card,panel}` → `rounded-card`, `rounded-chip`, …
 * Semantic colours (`bg-surface-2`, `text-status-ok`, …) need no extension —
 * tailwind-merge's colour groups already accept any token name.
 *
 * The `!`-important escape hatch used by the pre-#2484 fixes
 * (`!h-auto`, `hover:!bg-transparent`) keeps working: tailwind-merge treats an
 * important utility as its own conflict group, so it never merges an important
 * class away against a non-important one, and `!important` still wins in CSS.
 */

/** `space-1`…`space-8` (and fractional steps) from the `--spacing-space-*` tokens. */
const isSpaceToken = (value: string) => /^space-\d+(?:\.\d+)?$/.test(value);

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: [isSpaceToken],
      radius: ['chip', 'card', 'panel'],
    },
  },
});

export type ClassValue = string | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  return twMerge(parts.filter(Boolean).join(' '));
}
