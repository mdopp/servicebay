import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cn } from './cn';

/** Button's own defaults, verbatim from Button.tsx (the #2484 collision source). */
const BUTTON_MD = 'h-10 px-space-4 text-sm';
const BUTTON_SM = 'h-8 px-space-3 text-xs';
const BUTTON_GHOST = 'bg-transparent text-text-muted hover:bg-surface-2 hover:text-text';

const classes = (value: string) => value.split(' ').filter(Boolean);

describe('ui/cn', () => {
  it('joins parts and drops falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
    expect(cn()).toBe('');
    expect(cn('', false)).toBe('');
  });

  describe('conflict resolution — the caller className beats the primitive default (#2484)', () => {
    it('drops the primitive geometry the caller overrides', () => {
      const result = classes(cn(BUTTON_MD, 'h-auto px-6 py-3'));
      expect(result).toContain('h-auto');
      expect(result).toContain('px-6');
      expect(result).not.toContain('h-10');
      expect(result).not.toContain('px-space-4');
    });

    it('resolves the custom `--spacing-space-*` scale against the numeric scale', () => {
      // The original bug: without teaching tailwind-merge the repo's `space-*`
      // spacing namespace, `px-space-4` and `px-6` both survive and the winner
      // is decided by stylesheet emission order.
      expect(cn('px-space-4', 'px-6')).toBe('px-6');
      expect(cn('px-6', 'px-space-4')).toBe('px-space-4');
      expect(cn('gap-space-2', 'gap-0')).toBe('gap-0');
      expect(cn('mt-space-1', 'mt-4')).toBe('mt-4');
      // A later shorthand still clears the earlier axis utility.
      expect(cn('px-space-4', 'p-1')).toBe('p-1');
    });

    it('resolves the custom `--radius-*` scale', () => {
      expect(cn('rounded-card', 'rounded-chip')).toBe('rounded-chip');
      expect(cn('rounded-card', 'rounded-none')).toBe('rounded-none');
    });

    it('resolves semantic colour tokens', () => {
      expect(classes(cn(BUTTON_GHOST, 'text-accent'))).not.toContain('text-text-muted');
      expect(cn('bg-accent', 'bg-status-warn/10')).toBe('bg-status-warn/10');
      expect(cn('hover:bg-surface-2', 'hover:bg-transparent')).toBe('hover:bg-transparent');
    });

    it('keeps font-size and text-colour in separate groups', () => {
      // `text-sm` (size) must survive a `text-accent` (colour) override.
      expect(classes(cn('text-sm text-text-muted', 'text-accent'))).toEqual(
        expect.arrayContaining(['text-sm', 'text-accent']),
      );
      expect(cn('text-sm', 'text-xs')).toBe('text-xs');
    });

    it('keeps non-conflicting utilities from every part', () => {
      const result = classes(cn('inline-flex items-center', BUTTON_GHOST, BUTTON_SM, 'w-full'));
      for (const kept of ['inline-flex', 'items-center', 'bg-transparent', 'h-8', 'w-full']) {
        expect(result).toContain(kept);
      }
    });
  });

  describe('the `!`-important escape hatch of the pre-#2484 fixes still applies', () => {
    // #2479/#2482/#2483/#2487/#2490 forced their geometry with `!`-important.
    // tailwind-merge treats an important utility as its own conflict group, so
    // it must never merge one away against a non-important default — the
    // `!important` declaration then wins in CSS as those fixes intend.
    it.each([
      ['ServiceMonitor tab strip', BUTTON_MD, '!h-auto !px-6 py-3'],
      ['StackInstallFlow row', BUTTON_MD, '!h-auto !px-3 w-full justify-start py-2'],
      ['EmailNotificationsSection pill', BUTTON_MD, 'relative !h-6 !w-11 !px-0 !rounded-chip'],
      ['ApiTokensSection banner button', BUTTON_MD, '!h-auto !text-xs !px-3 !py-1.5'],
      ['PortalGrid how-to link', BUTTON_MD, '!h-auto !p-0 hover:!bg-transparent !text-accent'],
      ['NodesSection ssh link', BUTTON_MD, '!h-auto !px-0 !py-0 hover:!bg-transparent !text-accent'],
      ['Sidebar nav item', BUTTON_SM, '!h-auto !p-1.5'],
      ['CredentialsSection icon button', BUTTON_SM, '!h-auto !p-1'],
    ])('preserves every important override in %s', (_name, defaults, override) => {
      const result = classes(cn(defaults, override));
      for (const important of classes(override).filter((c) => c.includes('!'))) {
        expect(result).toContain(important);
      }
    });

    it('still merges two important utilities of the same group', () => {
      expect(cn('!px-6', '!px-3')).toBe('!px-3');
    });
  });

  describe('drift guard — every custom @theme token in globals.css is resolvable', () => {
    const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
    const tokens = (namespace: string) => [
      ...new Set(
        [...css.matchAll(new RegExp(`--${namespace}-([a-z0-9-]+):`, 'g'))].map((m) => m[1]),
      ),
    ];

    const spacingTokens = tokens('spacing');
    const radiusTokens = tokens('radius');

    it('found the token declarations to check', () => {
      expect(spacingTokens.length).toBeGreaterThan(0);
      expect(radiusTokens.length).toBeGreaterThan(0);
    });

    it.each(spacingTokens)('spacing token `%s` participates in padding conflicts', (token) => {
      expect(cn(`p-${token}`, 'p-0')).toBe('p-0');
      expect(cn('p-0', `p-${token}`)).toBe(`p-${token}`);
    });

    it.each(radiusTokens)('radius token `%s` participates in radius conflicts', (token) => {
      expect(cn(`rounded-${token}`, 'rounded-none')).toBe('rounded-none');
      expect(cn('rounded-none', `rounded-${token}`)).toBe(`rounded-${token}`);
    });
  });
});
