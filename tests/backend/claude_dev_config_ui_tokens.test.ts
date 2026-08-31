/**
 * claude-dev config UI: it wears ServiceBay's design tokens, not its own
 * palette (#2712).
 *
 * The operator opened the page and asked why it was in a different design from
 * ServiceBay. It wasn't built wrong — it was built *beside* the system: the
 * same idea with its own numbers, ageing independently. `service-ui-design-standard`
 * is explicit about the rule that prevents that: semantic tokens, never a
 * hard-coded hex, "so a theme change is one place".
 *
 * The config UI is a standalone static page inside its own container and cannot
 * import ServiceBay's frontend build, so the token VALUES have to travel. A
 * hand-copied palette would be the same defect one layer along — right on the
 * day it is written, silently apart a release later. So they are GENERATED
 * (`scripts/gen-service-ui-tokens.ts`) and this file is what makes the drift a
 * red: the freshness check below fails the suite the moment globals.css moves
 * and `tokens.css` doesn't.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePalette, renderTokens, SOURCE_REL, TARGETS } from '../../scripts/gen-service-ui-tokens';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui', 'public');
const SHELL_CSS = path.join(PUBLIC_DIR, 'shell.css');
const TOKENS_CSS = path.join(PUBLIC_DIR, 'tokens.css');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

const read = (p: string) => fs.readFileSync(p, 'utf-8');

/** Strip `/* … *\/` comments so a hex mentioned in prose isn't a false red. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('shell.css carries no colour literal of its own (the red-proof)', () => {
  it('has no hex literal', () => {
    const offenders = stripComments(read(SHELL_CSS))
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /#[0-9a-f]{3,8}\b/i.test(line));

    expect(
      offenders.map(o => `shell.css:${o.no}  ${o.line}`),
      'shell.css must reference tokens, never a hard-coded colour — a theme change is one place',
    ).toEqual([]);
  });

  it('has no rgb()/hsl() literal either', () => {
    const offenders = stripComments(read(SHELL_CSS))
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /\b(?:rgba?|hsla?)\s*\(/i.test(line));

    expect(offenders.map(o => `shell.css:${o.no}  ${o.line}`)).toEqual([]);
  });

  it('declares no palette of its own — every colour it names comes from the token sheet', () => {
    const shell = stripComments(read(SHELL_CSS));
    const declared = new Set([...shell.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]));
    const tokens = new Set([...stripComments(read(TOKENS_CSS)).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]));

    // shell.css defines no custom properties at all: the token sheet is the
    // only place a value lives.
    expect([...declared]).toEqual([]);

    // …and every token it USES is one the sheet actually ships, so a rename in
    // globals.css cannot leave the page rendering with unresolved vars.
    const used = new Set([...shell.matchAll(/var\((\s*--[a-z0-9-]+)/gi)].map(m => m[1].trim()));
    expect([...used].filter(name => !tokens.has(name))).toEqual([]);
  });

  it('has no per-mode colour override left — the token sheet owns light/dark', () => {
    const shell = stripComments(read(SHELL_CSS));
    expect(shell).not.toMatch(/prefers-color-scheme\s*:\s*dark/);
  });
});

describe('the token sheet is generated, and cannot drift from globals.css', () => {
  it('matches what the generator produces from the source of truth today', () => {
    const css = read(path.join(REPO_ROOT, SOURCE_REL));
    for (const target of TARGETS) {
      const expected = renderTokens(css, target);
      expect(
        read(path.join(REPO_ROOT, target.outRel)),
        `${target.outRel} is stale — run \`npm run gen:service-ui-tokens\` and commit the result`,
      ).toBe(expected);
    }
  });

  it('says out loud that it is generated, and where from', () => {
    const tokens = read(TOKENS_CSS);
    expect(tokens).toMatch(/GENERATED FILE/);
    expect(tokens).toContain(SOURCE_REL);
    expect(tokens).toContain('npm run gen:service-ui-tokens');
  });

  it('reads :root as the dark ramp and prefers-color-scheme:light as the override', () => {
    // ServiceBay has no class toggle: :root IS dark. Getting this backwards is
    // how a "themed" page ends up light in a dark admin UI.
    const { dark, light } = parsePalette(read(path.join(REPO_ROOT, SOURCE_REL)));
    expect(dark.get('--surface')).toBe('#111114');
    expect(light.get('--surface')).toBe('#ffffff');
    expect(dark.get('--svc-indigo-fg')).toBe('#818cf8');
    expect(light.get('--svc-indigo-fg')).toBe('#4f46e5');
  });

  it('ships both ramps for every semantic colour it ships at all', () => {
    const tokens = read(TOKENS_CSS);
    const [rootBlock, lightBlock] = tokens.split('@media (prefers-color-scheme: light)');
    const namesIn = (block: string) =>
      new Set([...stripComments(block).matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
    const rootNames = namesIn(rootBlock);
    const lightNames = namesIn(lightBlock ?? '');

    // Radii are mode-independent by design, and so is the accent — the
    // standard says surfaces/text/status shift between modes, "Accent is
    // unchanged". Everything else must ship both ramps.
    const modeIndependent = new Set([
      '--r-chip', '--r-card', '--r-panel',
      '--accent', '--accent-strong', '--on-accent',
    ]);
    const missing = [...rootNames].filter(n => !modeIndependent.has(n) && !lightNames.has(n));
    expect(missing).toEqual([]);
  });
});

describe('indigo is the identity colour, not a replacement for the accent', () => {
  it('uses the accent for the semantic layer: focus, primary action, active nav', () => {
    const shell = stripComments(read(SHELL_CSS));
    expect(shell).toMatch(/var\(--accent\)/);
    // The active-nav marker is a semantic accent, per the standard's
    // "accent = primary action, the active nav item, the focus ring".
    expect(shell).toMatch(/aria-current="page"\][\s\S]{0,220}var\(--accent\)/);
  });

  it('carries indigo only on the identity chip — never a full-card colour (#2126)', () => {
    const shell = stripComments(read(SHELL_CSS));
    const indigoRules = [...shell.matchAll(/([^{}]+)\{([^}]*--svc-indigo[^}]*)\}/g)];
    expect(indigoRules.length).toBeGreaterThan(0);
    for (const [, selector] of indigoRules) {
      expect(selector.trim()).toMatch(/shell-identity-chip/);
    }
    // The chip is exactly the sanctioned shape: a soft tinted fill plus a
    // saturated glyph, nothing else.
    const chipRule = indigoRules[0][2];
    expect(chipRule).toMatch(/background:\s*var\(--svc-indigo-bg\)/);
    expect(chipRule).toMatch(/color:\s*var\(--svc-indigo-fg\)/);
  });

  it('renders the identity chip in the page, decorative and not announced twice', () => {
    const html = read(INDEX_HTML);
    expect(html).toMatch(/class="shell-identity-chip"[^>]*aria-hidden="true"/);
  });
});

describe('the page actually loads the token sheet', () => {
  it('links tokens.css before shell.css, so shell.css can override nothing by accident', () => {
    const html = read(INDEX_HTML);
    const tokensAt = html.indexOf('/tokens.css');
    const shellAt = html.indexOf('/shell.css');
    expect(tokensAt).toBeGreaterThan(-1);
    expect(shellAt).toBeGreaterThan(-1);
    expect(tokensAt).toBeLessThan(shellAt);
  });

  it('is servable by the config-ui server (a .css under public/)', async () => {
    const { resolveStaticFile } = await import(
      /* @vite-ignore */ path.join(REPO_ROOT, 'templates', 'claude-dev', 'config-ui', 'server.mjs')
    );
    expect(resolveStaticFile('/tokens.css', PUBLIC_DIR)).toBe(TOKENS_CSS);
  });
});
