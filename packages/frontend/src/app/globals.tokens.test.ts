import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design-system semantic token layer (#2072, epic #2071).
 *
 * Encodes the acceptance criterion ("all tokens defined and resolvable;
 * theme extended; dark-mode correct") so #2073-#2079 build on a stable
 * foundation and a later refactor can't silently drop a token. We parse
 * globals.css textually (jsdom doesn't resolve @theme/@import), which is
 * enough to assert each token is declared in :root, registered in @theme
 * inline, and overridden for light mode.
 */
const cssPath = path.resolve(__dirname, './globals.css');
const css = readFileSync(cssPath, 'utf8');

const block = (header: string): string => {
  const start = css.indexOf(header);
  expect(start, `block "${header}" present`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  // naive brace match — these blocks have no nested braces except the light
  // @media, which we handle by passing the inner ":root" header for that case.
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces for ${header}`);
};

// The first ":root {" is the dark default; the light override is inside
// "@media (prefers-color-scheme: light)".
const rootDark = block(':root {');
const lightMedia = block('@media (prefers-color-scheme: light)');
const themeInline = block('@theme inline {');

const SEMANTIC_COLOR_TOKENS = [
  'surface',
  'surface-2',
  'surface-muted',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-subtle',
  'status-ok',
  'status-warn',
  'status-fail',
  'status-info',
  'accent',
  'accent-strong',
  'on-accent',
];

describe('design-system semantic tokens (#2072)', () => {
  it.each(SEMANTIC_COLOR_TOKENS)('defines --%s on :root (dark default)', (token) => {
    expect(rootDark).toMatch(new RegExp(`--${token}\\s*:`));
  });

  it.each(SEMANTIC_COLOR_TOKENS)('registers --color-%s in @theme inline', (token) => {
    expect(themeInline).toMatch(new RegExp(`--color-${token}\\s*:\\s*var\\(--${token}\\)`));
  });

  it('overrides surface/border/text/status for light mode', () => {
    for (const token of [
      'surface',
      'surface-2',
      'border',
      'text',
      'text-muted',
      'status-ok',
      'status-warn',
      'status-fail',
      'status-info',
    ]) {
      expect(lightMedia, `light override for --${token}`).toMatch(
        new RegExp(`--${token}\\s*:`),
      );
    }
  });

  it('exposes ONE canonical radius scale without clobbering numeric rounded-*', () => {
    for (const r of ['radius-chip', 'radius-card', 'radius-panel']) {
      expect(themeInline).toMatch(new RegExp(`--${r}\\s*:`));
    }
    // must NOT redefine Tailwind's numeric radius scale (would change existing UI)
    expect(themeInline).not.toMatch(/--radius-sm\s*:/);
    expect(themeInline).not.toMatch(/--radius-lg\s*:/);
  });

  it('exposes a 4px-base spacing scale under the space-N namespace (not numeric)', () => {
    for (let n = 1; n <= 8; n++) {
      expect(themeInline).toMatch(new RegExp(`--spacing-space-${n}\\s*:`));
    }
    // must NOT redefine numeric spacing (p-5/gap-6 must keep Tailwind defaults)
    expect(themeInline).not.toMatch(/--spacing-5\s*:/);
  });

  it('dark status colors use the legible 400-ramp (operator uses dark mode)', () => {
    expect(rootDark).toMatch(/--status-ok\s*:\s*#34d399/i); // emerald-400
    expect(rootDark).toMatch(/--status-warn\s*:\s*#fbbf24/i); // amber-400
    expect(rootDark).toMatch(/--status-fail\s*:\s*#f87171/i); // red-400
    expect(rootDark).toMatch(/--status-info\s*:\s*#60a5fa/i); // blue-400
  });
});
