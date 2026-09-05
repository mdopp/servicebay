/**
 * list_assists filters + get_assist brief mode (#2813, from the #2804 finding).
 *
 * #2804 measured a 65k-context coding agent spending its whole window reading
 * catalog prose: `list_assists` had no way to narrow ~55 entries, and every
 * `get_assist` carried cross-reference footers and provenance the builder cannot
 * act on. These are the two narrowing knobs — and, just as important, the proof
 * that a caller who passes neither sees exactly what it saw before.
 *
 * Runs against the REAL repo catalog (vitest points ASSIST_CATALOG_DIR at
 * `assists/`), so a filter that silently matched nothing would fail here.
 */

import { describe, it, expect } from 'vitest';
import { listAssists, getAssist, stripAssistProvenance } from '@/lib/assists/catalog';

describe('list_assists filters (#2813)', () => {
  it('no args still returns the full catalog — existing callers unchanged', async () => {
    const all = await listAssists();
    expect(all.length).toBeGreaterThan(30);
    // Every kind the catalog holds is still represented; nothing is filtered.
    expect(new Set(all.map(a => a.kind)).size).toBeGreaterThan(1);
  });

  it('kind returns ONLY that kind, and fewer entries than the full catalog', async () => {
    const all = await listAssists();
    const footguns = await listAssists({ kind: 'footgun' });
    expect(footguns.length).toBeGreaterThan(0);
    expect(footguns.length).toBeLessThan(all.length);
    for (const a of footguns) expect(a.kind).toBe('footgun');
  });

  it('tag returns only entries carrying that tag, case-insensitively', async () => {
    const all = await listAssists();
    const tagged = await listAssists({ tag: 'ADR' });
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.length).toBeLessThan(all.length);
    for (const a of tagged) {
      expect(a.tags.map(t => t.toLowerCase()), `${a.id} carries the tag`).toContain('adr');
    }
    // Whole-tag match, not a substring: "ad" is not a tag anything carries.
    expect(await listAssists({ tag: 'ad' })).toEqual([]);
  });

  it('q is a substring filter over title + whenToUse', async () => {
    const all = await listAssists();
    const hits = await listAssists({ q: 'template' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(all.length);
    for (const a of hits) {
      expect(`${a.title}\n${a.whenToUse}`.toLowerCase(), `${a.id} matches`).toContain('template');
    }
    expect(await listAssists({ q: 'zzz-no-such-phrase-zzz' })).toEqual([]);
  });

  it('filters compose — kind AND q together narrow further than either alone', async () => {
    const footguns = await listAssists({ kind: 'footgun' });
    const both = await listAssists({ kind: 'footgun', q: 'subdomain' });
    expect(both.length).toBeGreaterThan(0);
    expect(both.length).toBeLessThanOrEqual(footguns.length);
    for (const a of both) expect(a.kind).toBe('footgun');
  });
});

describe('get_assist brief mode (#2813)', () => {
  it('drops a "## Related" section but keeps the rest of the entry', async () => {
    const full = (await getAssist('servicebay-overview')) ?? '';
    const brief = (await getAssist('servicebay-overview', { brief: true })) ?? '';
    expect(full).toContain('## Related assists');
    expect(brief).not.toContain('## Related assists');
    expect(brief.length).toBeLessThan(full.length);
    // Frontmatter and the actionable body survive.
    expect(brief.startsWith('---')).toBe(true);
    expect(brief).toContain('title:');
  });

  it('drops a trailing "Related: …" prose footer', async () => {
    const full = (await getAssist('long-running-process')) ?? '';
    const brief = (await getAssist('long-running-process', { brief: true })) ?? '';
    expect(full).toMatch(/^Related:/m);
    expect(brief).not.toMatch(/^Related:/m);
    // The numbered rules — the whole point of the entry — are still there.
    expect(brief).toContain('reconnect');
  });

  it('keeps ADR amendments — an amendment is the current rule, not chronology', async () => {
    const brief = (await getAssist('adr-0007-container-network-isolation-and-carveouts', { brief: true })) ?? '';
    expect(brief).toContain('## Decision');
    expect(brief).toMatch(/## Amendment/);
  });

  it('brief=false / omitted returns the byte-identical full text', async () => {
    for (const id of ['servicebay-overview', 'long-running-process', 'create-service']) {
      const raw = (await getAssist(id)) ?? '';
      expect(raw.length, `${id} has content`).toBeGreaterThan(0);
      expect(await getAssist(id, {})).toBe(raw);
      expect(await getAssist(id, { brief: false })).toBe(raw);
    }
  });

  it('an unknown id is still null in brief mode', async () => {
    expect(await getAssist('no-such-assist-zzz', { brief: true })).toBeNull();
  });
});

describe('stripAssistProvenance (#2813)', () => {
  it('drops Related/History sections up to the next same-or-higher heading', () => {
    const out = stripAssistProvenance(
      ['---', 'title: X', '---', '', '## Rules', 'keep me', '', '## Related', 'drop me', '', '### also dropped', 'drop me too', '', '## History', 'old news', '', '## Verify', 'keep this too', ''].join('\n'),
    );
    expect(out).toContain('keep me');
    expect(out).toContain('keep this too');
    expect(out).not.toContain('drop me');
    expect(out).not.toContain('also dropped');
    expect(out).not.toContain('old news');
    expect(out).toContain('## Verify');
  });

  it('never edits inside a fenced code block', () => {
    const out = stripAssistProvenance(
      ['## Rules', '```md', '## Related', 'Related: this is sample content', '```', 'after'].join('\n'),
    );
    expect(out).toContain('## Related');
    expect(out).toContain('Related: this is sample content');
    expect(out).toContain('after');
  });

  it('is a no-op on an entry that carries no provenance', () => {
    const raw = '---\ntitle: X\n---\n\n## Rules\n1. do the thing\n';
    expect(stripAssistProvenance(raw)).toBe(raw);
  });
});
