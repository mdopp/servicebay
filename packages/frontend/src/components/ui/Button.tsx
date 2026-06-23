'use client';

import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * <Button> — the shared action primitive (#2073, epic #2071).
 *
 * Replaces the audited 124 ad-hoc button class-chains with one consistent
 * padding / radius / hover / focus / disabled story, wired to the semantic
 * tokens from #2072 (no raw blue-600 / gray-800 literals). Dark-mode-correct
 * by construction: every colour resolves through a CSS variable that already
 * has a light/dark value.
 *
 * Variants:
 *  - primary   — accent fill, the page's main action.
 *  - secondary — bordered surface, neutral.
 *  - ghost     — no chrome until hover, for low-emphasis / icon actions.
 *  - danger    — destructive (delete/uninstall); status-fail tinted.
 *
 * Sizes: sm (compact rows/toolbars) · md (default).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const base =
  'inline-flex items-center justify-center gap-space-2 rounded-card font-medium ' +
  'transition-colors select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-surface ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-strong',
  secondary:
    'bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong',
  ghost: 'bg-transparent text-text-muted hover:bg-surface-2 hover:text-text',
  danger:
    'bg-transparent text-status-fail border border-status-fail/40 hover:bg-status-fail/10 ' +
    'focus-visible:ring-status-fail',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-space-3 text-xs',
  md: 'h-10 px-space-4 text-sm',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // Default to type="button" so a primitive dropped inside a <form> doesn't
      // submit it by surprise — opt into "submit" explicitly.
      type={type ?? 'button'}
      data-variant={variant}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    />
  );
});

