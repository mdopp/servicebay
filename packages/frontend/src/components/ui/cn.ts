/**
 * Tiny class-name joiner for the design-system primitives (#2071).
 *
 * The repo has no clsx/tailwind-merge dependency, and the primitives only need
 * to drop falsy values and join with spaces (variant maps are authored to not
 * collide, so we don't need conflict-resolution merging). Keep it dependency-free.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}
