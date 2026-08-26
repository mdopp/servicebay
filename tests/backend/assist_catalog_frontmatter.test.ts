/**
 * @vitest-environment node
 *
 * (node, not the repo-default jsdom: esbuild refuses to run under jsdom's
 * TextEncoder — `new TextEncoder().encode('') instanceof Uint8Array` is false
 * there — and this suite builds a real bundle.)
 *
 * #2650 — the assist catalog was blind on the box while every source-level test
 * stayed green.
 *
 * What actually happened, and why it needs THIS shape of test:
 *
 *  - `scripts/build-server.mjs` marked `js-yaml` **external**, so node — not
 *    esbuild — resolved it at runtime, from `/app/node_modules`. The bundled
 *    copy of `gray-matter` is written against js-yaml **3** (`yaml.safeLoad`);
 *    the root has **4**, where `safeLoad` throws "removed in js-yaml 4". Every
 *    frontmatter parse in the shipped bundle failed.
 *  - `gray-matter` puts the file object into `matter.cache` BEFORE parsing it,
 *    so the first parse threw (logged, entry skipped) and every parse after that
 *    was served the cached half-built object with `data: {}` and no error at
 *    all. That is why the box reported 40 entries whose title was the filename,
 *    `whenToUse: ""`, `kind: "guide"`, `tags: []` — a silent, plausible-looking
 *    lie — and why `list_assists(kind:"adr")` returned `[]`.
 *  - Read straight from source (tsx, vitest) node resolves `require('js-yaml')`
 *    to gray-matter's own nested js-yaml 3 and everything works. So a test that
 *    imports the TS module can NEVER see this class of bug.
 *
 * Hence: the first suite bundles the catalog with the EXACT production esbuild
 * options and asserts against the built CJS artefact. The second asserts that
 * unreadable frontmatter is loud — an error and a dropped entry, never a stub.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build, type BuildOptions } from 'esbuild';
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { serverBundleOptions } from '../../scripts/build-server.mjs';
import type { AssistSummary } from '@/lib/assists/catalog';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Same dir the shipped bundle lands in, on purpose: an `external` is resolved by
// node from the nearest node_modules ABOVE the bundle, so `dist-server/` here
// reproduces `/app/dist-server` → `/app/node_modules` exactly.
const OUT_FILE = path.join(REPO_ROOT, 'dist-server', 'assist-catalog.bundle-test.cjs');

interface BundledCatalog {
  listAssists(opts?: { query?: string; kind?: string }): Promise<AssistSummary[]>;
  buildServiceStandards(flavor: 'servicebay'): Promise<{
    mustRespectAdrs: unknown[];
    adrCatalog: { count: number };
  }>;
}

/** Is this entry the metadata-less fallback the box served for all 40 assists? */
const isStub = (a: AssistSummary) =>
  a.title === a.id && a.whenToUse === '' && a.tags.length === 0;

describe('#2650 — the catalog parses frontmatter in the BUNDLED server, not just from source', () => {
  let bundled: BundledCatalog;

  beforeAll(async () => {
    const options = serverBundleOptions({
      outfile: OUT_FILE,
      sourcemap: false,
      logLevel: 'silent',
    }) as BuildOptions;
    // stdin replaces the server.ts entry point; esbuild rejects having both.
    delete options.entryPoints;
    options.stdin = {
      contents:
        "export { listAssists } from '@/lib/assists/catalog';\n" +
        "export { buildServiceStandards } from '@/lib/mcp/serviceStandards';\n",
      resolveDir: REPO_ROOT,
      loader: 'ts',
      sourcefile: 'assist-catalog-bundle-entry.ts',
    };
    await build(options);
    bundled = createRequire(import.meta.url)(OUT_FILE) as BundledCatalog;
  }, 120_000);

  afterAll(() => {
    fs.rmSync(OUT_FILE, { force: true });
  });

  it('serves real titles, whenToUse lines, kinds and tags out of the bundle', async () => {
    const entries = await bundled.listAssists();
    expect(entries.length).toBeGreaterThan(0);

    const stubs = entries.filter(isStub).map(a => a.id);
    expect(stubs, `entries served with no metadata: ${stubs.join(', ')}`).toEqual([]);
    expect(entries.every(a => a.whenToUse.length > 0)).toBe(true);
    expect(entries.some(a => a.tags.length > 0)).toBe(true);
    // `guide` is the coerce fallback — if EVERY kind is guide, nothing was read.
    expect(new Set(entries.map(a => a.kind)).size).toBeGreaterThan(1);
  });

  it('returns the ADRs under kind "adr" from the bundle', async () => {
    const adrs = await bundled.listAssists({ kind: 'adr' });
    const numbered = adrs.filter(a => /^adr-\d{4}-/.test(a.id));
    expect(numbered.length).toBeGreaterThanOrEqual(12);
    expect(numbered.every(a => a.title !== a.id && a.whenToUse.length > 0)).toBe(true);
  });

  it('lists those ADRs under get_service_standards mustRespectAdrs, from the bundle', async () => {
    // The downstream symptom operators actually hit: `mustRespectAdrs: []` and
    // `adrCatalog.count: 0` while 12 adr-*.md sat in /app/assists.
    const standards = await bundled.buildServiceStandards('servicebay');
    expect(standards.mustRespectAdrs.length).toBeGreaterThanOrEqual(12);
    expect(standards.adrCatalog.count).toBe(standards.mustRespectAdrs.length);
  });

  it('is stable across repeated calls — gray-matter never serves a cached half-parsed file', async () => {
    // The box only looked healthy-ish because call #2 differed from call #1: the
    // first threw and skipped, the rest were fed the poisoned cache entry.
    const first = await bundled.listAssists();
    const second = await bundled.listAssists();
    expect(second).toEqual(first);
    expect(second.filter(isStub)).toEqual([]);
  });
});

describe('#2650 — unreadable frontmatter is loud, never a silent fallback', () => {
  afterEach(() => {
    vi.doUnmock('gray-matter');
    vi.resetModules();
  });

  it('throws instead of listing metadata-less stubs when the parser yields nothing', async () => {
    // Exactly what the broken bundle did: `matter()` returns empty data without
    // throwing, for every file. Previously that produced a full, useless list.
    vi.doMock('gray-matter', () => ({
      default: () => ({ data: {}, content: '', excerpt: '', orig: '' }),
    }));
    vi.resetModules();
    const { listAssists, AssistCatalogParseError } = await import('@/lib/assists/catalog');

    await expect(listAssists()).rejects.toBeInstanceOf(AssistCatalogParseError);
  });

  it('throws when the YAML engine throws for every entry', async () => {
    vi.doMock('gray-matter', () => ({
      default: () => {
        throw new Error('Function yaml.safeLoad is removed in js-yaml 4.');
      },
    }));
    vi.resetModules();
    const { listAssists, AssistCatalogParseError } = await import('@/lib/assists/catalog');

    await expect(listAssists()).rejects.toBeInstanceOf(AssistCatalogParseError);
  });

  it('drops a single unreadable entry rather than publishing it without metadata', async () => {
    const { listAssists } = await import('@/lib/assists/catalog');
    const dropDir = path.join(process.env.DATA_DIR!, 'local-assists');
    const broken = path.join(dropDir, 'zz-broken-frontmatter-2650.md');
    fs.mkdirSync(dropDir, { recursive: true });
    // Unterminated quote — js-yaml throws on this block.
    fs.writeFileSync(broken, '---\ntitle: "unterminated\nkind: guide\n---\n\nbody\n');
    try {
      const entries = await listAssists();
      expect(entries.map(a => a.id)).not.toContain('zz-broken-frontmatter-2650');
      // The rest of the catalog still loads — one bad file is not systemic.
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(broken, { force: true });
    }
  });
});
