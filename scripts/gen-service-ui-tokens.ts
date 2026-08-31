#!/usr/bin/env node
/**
 * Regenerate a standalone service UI's design-token stylesheet from the single
 * source of truth in `packages/frontend/src/app/globals.css` (#2712).
 *
 * Run: `npm run gen:service-ui-tokens` (writes the file) or
 *      `npm run gen:service-ui-tokens -- --check` (CI / the test suite: exits
 *      non-zero if the file on disk is not what the source produces today).
 *
 * WHY A GENERATOR AND NOT A COPY.  The claude-dev configuration UI is a
 * standalone static page served from inside its own container; it cannot
 * import ServiceBay's frontend build, so the token VALUES have to travel. A
 * hand-copied palette is the same defect the issue is about, one layer along:
 * it looks right the day it is written and ages apart from the original in
 * silence. Generating it, and asserting in the suite that the checked-in file
 * still matches its source, makes the drift a red instead of a surprise on the
 * operator's screen.
 *
 * WHAT TRAVELS.  Colour (semantic surfaces/borders/text, the status ramp, the
 * accent) and the radius scale — the values a stylesheet would otherwise
 * hard-code. Deliberately NOT the spacing scale (the shell lays out in plain
 * rem and remapping it buys nothing here) and NOT the font stack (ServiceBay's
 * Geist/Inter are bundled by the Next build and are absent from the container,
 * so importing the names would degrade the page to a generic sans instead of
 * the system UI font it renders in today).
 *
 * The per-service identity pair (`--svc-indigo-*`) travels too: it is the
 * *identity* colour of this service (#2126), a soft tinted fill plus a
 * saturated icon on an icon chip — never a full-card colour, and never a
 * replacement for `--accent`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const SOURCE_REL = 'packages/frontend/src/app/globals.css';

/** Every generated stylesheet: where it goes, and which service identity it carries. */
export const TARGETS = [
  {
    outRel: 'templates/claude-dev/config-ui/public/tokens.css',
    service: 'claude-dev',
    identity: 'indigo',
  },
] as const;

/**
 * The tokens that travel. Names are the source's own — a service stylesheet
 * that says `var(--surface)` says the same thing ServiceBay's does.
 */
const SEMANTIC_TOKENS = [
  '--background',
  '--surface',
  '--surface-2',
  '--surface-muted',
  '--border',
  '--border-strong',
  '--text',
  '--text-muted',
  '--text-subtle',
  '--status-ok',
  '--status-warn',
  '--status-fail',
  '--status-info',
  '--accent',
  '--accent-strong',
  '--on-accent',
  '--r-chip',
  '--r-card',
  '--r-panel',
] as const;

type Palette = { dark: Map<string, string>; light: Map<string, string> };

/**
 * Read every custom-property declaration out of globals.css, split by mode.
 *
 * `:root` in ServiceBay IS dark (there is no `.dark` class toggle); a
 * `@media (prefers-color-scheme: light)` block overrides it. So: declarations
 * inside such a media block are the light ramp, everything else is the dark
 * default. Both `:root` blocks and both light blocks contribute — the semantic
 * layer and the per-service identity map are declared separately in the source.
 */
export function parsePalette(css: string): Palette {
  const dark = new Map<string, string>();
  const light = new Map<string, string>();
  let depth = 0;
  let lightAtDepth: number | null = null;

  for (const raw of css.split('\n')) {
    const line = raw.trim();
    const opensLightMedia = /^@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)/.test(line);

    for (const [, name, value] of raw.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
      const target = lightAtDepth === null ? dark : light;
      target.set(`--${name}`, value.trim());
    }

    for (const ch of raw) {
      if (ch === '{') {
        depth += 1;
        if (opensLightMedia && lightAtDepth === null) lightAtDepth = depth;
      } else if (ch === '}') {
        if (lightAtDepth !== null && depth === lightAtDepth) lightAtDepth = null;
        depth -= 1;
      }
    }
  }

  return { dark, light };
}

function require_(palette: Map<string, string>, name: string, mode: string): string {
  const value = palette.get(name);
  if (value === undefined) {
    throw new Error(
      `${SOURCE_REL} no longer declares ${name} in the ${mode} ramp — ` +
        `update scripts/gen-service-ui-tokens.ts to match the source of truth.`,
    );
  }
  return value;
}

const pad = (name: string, width: number) => `${name}:`.padEnd(width + 1);

export function renderTokens(css: string, target: (typeof TARGETS)[number]): string {
  const { dark, light } = parsePalette(css);
  const identity = [`--svc-${target.identity}-bg`, `--svc-${target.identity}-fg`];
  const width = Math.max(...[...SEMANTIC_TOKENS, ...identity].map(n => n.length));

  const block = (mode: 'dark' | 'light', indent: string) => {
    const source = mode === 'dark' ? dark : light;
    const lines: string[] = [];
    for (const name of SEMANTIC_TOKENS) {
      // Radii and spacing are mode-independent: they are declared once, on the
      // dark `:root`, and have no light override to emit.
      if (mode === 'light' && !source.has(name)) continue;
      lines.push(`${indent}${pad(name, width)} ${require_(source, name, mode)};`);
    }
    lines.push('');
    lines.push(`${indent}/* Per-service identity (#2126): icon-chip fill + icon colour only. */`);
    for (const name of identity) {
      lines.push(`${indent}${pad(name, width)} ${require_(source, name, mode)};`);
    }
    return lines.join('\n');
  };

  return `/* GENERATED FILE — do not edit by hand.
 *
 * Source:      ${SOURCE_REL}
 * Generator:   scripts/gen-service-ui-tokens.ts
 * Regenerate:  npm run gen:service-ui-tokens
 * Drift check: npm run gen:service-ui-tokens -- --check   (also asserted by the
 *              test suite, so a token change in the source that is not
 *              regenerated here fails CI instead of ageing apart in silence.)
 *
 * ${target.service} is a standalone page served from inside its own container —
 * it cannot import ServiceBay's frontend build, so the token values travel
 * here. The NAMES are the source's own, so a stylesheet that says
 * \`var(--surface)\` means exactly what it means in the admin UI.
 *
 * \`:root\` IS dark (ServiceBay has no class toggle); the light ramp is an
 * override below.
 */

:root {
${block('dark', '  ')}
}

@media (prefers-color-scheme: light) {
  :root {
${block('light', '    ')}
  }
}
`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const css = fs.readFileSync(path.join(REPO_ROOT, SOURCE_REL), 'utf-8');
  let stale = 0;

  for (const target of TARGETS) {
    const outPath = path.join(REPO_ROOT, target.outRel);
    const next = renderTokens(css, target);
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : null;
    if (current === next) {
      if (!check) console.log(`unchanged  ${target.outRel}`);
      continue;
    }
    if (check) {
      stale += 1;
      console.error(`STALE      ${target.outRel} — regenerate with \`npm run gen:service-ui-tokens\``);
      continue;
    }
    fs.writeFileSync(outPath, next);
    console.log(`wrote      ${target.outRel}`);
  }

  if (stale > 0) {
    console.error(`\n${stale} generated token stylesheet(s) drifted from ${SOURCE_REL}.`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();
