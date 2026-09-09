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
import { listAssists, getAssist, stripAssistProvenance, assistHaystack, applyAssistFilters } from '@/lib/assists/catalog';

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

  it('q is a substring filter over the searchable text, and still narrows', async () => {
    const all = await listAssists();
    const hits = await listAssists({ q: 'template' });
    expect(hits.length).toBeGreaterThan(0);
    // Still a FILTER: a real word must not degrade into "matches everything".
    expect(hits.length).toBeLessThan(all.length);
    for (const a of hits) {
      expect(assistHaystack(a), `${a.id} matches`).toContain('template');
    }
    // ...and an entry the needle does not appear in is genuinely excluded.
    const missed = all.filter(a => !assistHaystack(a).includes('template'));
    expect(missed.length).toBeGreaterThan(0);
    for (const a of missed) {
      expect(hits.map(h => h.id), `${a.id} is filtered out`).not.toContain(a.id);
    }
    expect(await listAssists({ q: 'zzz-no-such-phrase-zzz' })).toEqual([]);
  });

  it('q still matches title and whenToUse prose, as it always did', async () => {
    const all = await listAssists();
    const [sample] = all;
    // A phrase that only the title carries, and one only whenToUse carries.
    const titleHit = await listAssists({ q: sample.title.toLowerCase() });
    expect(titleHit.map(a => a.id), 'title text still filters').toContain(sample.id);
    const when = sample.whenToUse.toLowerCase();
    expect(when.length, `${sample.id} has whenToUse text`).toBeGreaterThan(0);
    const whenHit = await listAssists({ q: when });
    expect(whenHit.map(a => a.id), 'whenToUse text still filters').toContain(sample.id);
  });

  it('filters compose — kind AND q together narrow further than either alone', async () => {
    const footguns = await listAssists({ kind: 'footgun' });
    const both = await listAssists({ kind: 'footgun', q: 'subdomain' });
    expect(both.length).toBeGreaterThan(0);
    expect(both.length).toBeLessThanOrEqual(footguns.length);
    for (const a of both) expect(a.kind).toBe('footgun');
  });
});

/**
 * #2917: `q` matched only title + whenToUse while `query` ranked over id +
 * title + whenToUse + kind + tags, 29 lines apart in the same file. So
 * `q: "overview"` returned [] on the live box while both `*-overview` guides
 * sat in the catalog tagged `overview` — an empty list from a discovery tool
 * reads as "no such assist", and the agent re-derives what it already had.
 *
 * These tests are CLASS-level on purpose: they sweep every field the shared
 * haystack contributes, so a field added to `assistHaystack` later is covered
 * without anyone remembering to extend the test.
 */
describe('list_assists q covers every field the ranker searches (#2917)', () => {
  it('q:"overview" returns both orientation guides — the measured miss', async () => {
    const ids = (await listAssists({ q: 'overview' })).map(a => a.id);
    expect(ids).toContain('servicebay-overview');
    expect(ids).toContain('solaris-overview');
  });

  it('q reaches an entry by its id', async () => {
    const ids = (await listAssists({ q: 'solaris-overview' })).map(a => a.id);
    expect(ids).toContain('solaris-overview');
  });

  it('q reaches an entry by a tag that appears nowhere else in its text', async () => {
    const tagOnly = 'household-ai';
    const solaris = (await listAssists()).find(a => a.id === 'solaris-overview');
    expect(solaris, 'solaris-overview is in the catalog').toBeDefined();
    expect(solaris!.tags).toContain(tagOnly);
    expect(`${solaris!.title}\n${solaris!.whenToUse}`.toLowerCase(), 'tag-only needle').not.toContain(tagOnly);
    expect((await listAssists({ q: tagOnly })).map(a => a.id)).toContain('solaris-overview');
  });

  it('the match stays case-insensitive, both sides', async () => {
    const lower = (await listAssists({ q: 'overview' })).map(a => a.id);
    const upper = (await listAssists({ q: 'OVERVIEW' })).map(a => a.id);
    const mixed = (await listAssists({ q: '  OvErViEw  ' })).map(a => a.id);
    expect(lower.length).toBeGreaterThan(0);
    expect(upper).toEqual(lower);
    expect(mixed).toEqual(lower);
  });

  it('EVERY field of EVERY entry is reachable through q — driven off the shared haystack', async () => {
    const all = await listAssists();
    expect(all.length).toBeGreaterThan(30);
    let probes = 0;
    for (const a of all) {
      // Whatever `assistHaystack` contributes — today id, title, whenToUse,
      // kind and one line per tag — must be a needle that finds this entry.
      const fields = assistHaystack(a).split('\n').filter(f => f.trim().length > 0);
      expect(fields.length, `${a.id} contributes searchable fields`).toBeGreaterThanOrEqual(3);
      for (const field of fields) {
        const hits = applyAssistFilters(all, { q: field }).map(e => e.id);
        expect(hits, `${a.id} is reachable by q:"${field}"`).toContain(a.id);
        probes++;
      }
      // Never "everything matches": the entry's own id excludes other entries.
      expect(applyAssistFilters(all, { q: a.id }).length, `q:"${a.id}" narrows`).toBeLessThan(all.length);
    }
    expect(probes, 'the sweep really probed every field of every entry').toBeGreaterThan(all.length * 3);
  });

  it('q and query agree on a single-token needle — q can no longer hide what query ranks first', async () => {
    // Same predicate, different jobs: `query` ranks the set, `q` filters it.
    // A field list that drifted apart again shows up here as a set difference.
    const all = await listAssists();
    const needles = ['overview', 'adr', 'guide', 'servicebay-overview', 'household-ai', 'backup'];
    for (const needle of needles) {
      const expected = all.filter(a => assistHaystack(a).includes(needle)).map(a => a.id).sort();
      expect(expected.length, `${needle} matches something`).toBeGreaterThan(0);
      const filtered = (await listAssists({ q: needle })).map(a => a.id).sort();
      const ranked = (await listAssists({ query: needle })).map(a => a.id).sort();
      expect(filtered, `q:"${needle}"`).toEqual(expected);
      expect(ranked, `query:"${needle}"`).toEqual(expected);
    }
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
