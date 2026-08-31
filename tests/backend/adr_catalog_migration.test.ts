/**
 * ADRs live in the assist catalog (#2607), and the 0009 collision is gone (#2617).
 *
 * The failure being fixed was not "the ADRs are missing" — it was **"13 decisions
 * exist and nobody finds them."** They sat under `docs/adr/`, which an agent
 * working over MCP cannot open: `get_service_standards` handed back a title, a
 * one-line note and a path no tool could follow, for 6 of them, and only when
 * the agent happened to be bootstrapping a new service.
 *
 * So this suite asserts the properties that make the move *worth* something,
 * not just that files moved:
 *
 *  1. Exactly one record per ADR number (#2617 — two files claimed 0009).
 *  2. Every ADR is retrievable as FULL TEXT from the catalog, not a summary.
 *  3. Every `whenToUse` **discriminates**: a query phrased as the situation an
 *     agent is actually in ranks its ADR above the other eleven. A vague line
 *     passes a "frontmatter exists" check and still leaves the decision
 *     unfindable — that is the problem being relocated instead of solved.
 *  4. Every old `docs/adr/NNNN-*.md` path still resolves to a signpost naming
 *     the new home, so links from PRs, issues and code comments don't dead-end.
 *  5. `docs/adr/` holds no second copy of any decision (one copy, one place).
 *  6. The orientation docs name the catalog as where decisions live now.
 *
 * Pure file-system + catalog reads (process.cwd() is the repo root under
 * vitest). No agent / network needed.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { listAssists, getAssist, type AssistSummary } from '@/lib/assists/catalog';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');
const ASSISTS_DIR = path.join(REPO_ROOT, 'assists');

/** `adr-NNNN-<slug>` — the id shape a numbered ADR carries in the catalog. */
const ADR_ID = /^adr-(\d{4})-[a-z0-9-]+$/;

/** Every numbered-ADR record in the catalog, ascending. */
async function adrRecords(): Promise<AssistSummary[]> {
  const all = await listAssists({ kind: 'adr' });
  return all.filter(a => ADR_ID.test(a.id)).sort((a, b) => a.id.localeCompare(b.id));
}

const adrNumber = (id: string) => ADR_ID.exec(id)![1];

/** Signpost files left behind under docs/adr/ (everything but the index). */
function signpostFiles(): string[] {
  return fs.readdirSync(ADR_DIR).filter(f => /^\d{4}-.*\.md$/.test(f)).sort();
}

describe('#2617 — the 0009 collision is resolved', () => {
  it('exactly one record claims each ADR number', async () => {
    const nums = (await adrRecords()).map(a => adrNumber(a.id));
    const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
    expect(dupes, `ADR number(s) claimed twice: ${dupes.join(', ')}`).toEqual([]);
    expect(nums.length).toBeGreaterThanOrEqual(12);
  });

  it('0009 is tokens-and-trust; repair-is-reconciliation is 0012', async () => {
    const byNum = new Map((await adrRecords()).map(a => [adrNumber(a.id), a.id]));
    expect(byNum.get('0009')).toBe('adr-0009-service-tokens-and-trust');
    expect(byNum.get('0012')).toBe('adr-0012-repair-is-reconciliation-not-reinstallation');
  });

  it('the renumbered record says so in its own text, so a reader is never confused', async () => {
    const body = (await getAssist('adr-0012-repair-is-reconciliation-not-reinstallation')) ?? '';
    expect(body).toContain('# ADR 0012');
    expect(body).not.toContain('# ADR 0009');
    expect(body, 'names its old number').toMatch(/Renumbered|0009/);
  });

  it('BOTH the old 0009-repair path and the new 0012 path resolve to it', () => {
    for (const f of [
      '0009-repair-is-reconciliation-not-reinstallation.md',
      '0012-repair-is-reconciliation-not-reinstallation.md',
    ]) {
      const p = path.join(ADR_DIR, f);
      expect(fs.existsSync(p), `${f} exists so old references don't 404`).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toContain('adr-0012-repair-is-reconciliation-not-reinstallation');
    }
  });

  it('every ADR number is in the index, including the renumbered one', () => {
    const index = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf-8');
    const nums = signpostFiles().map(f => f.slice(0, 4));
    for (const n of new Set(nums)) {
      expect(index, `index lists ADR ${n}`).toMatch(new RegExp(`\\|\\s*${n}\\s*\\|`));
    }
    // The orphan's failure mode was precisely "not in the index".
    expect(index).toContain('adr-0012-repair-is-reconciliation-not-reinstallation');
  });
});

describe('#2607 — the ADRs are retrievable full-text from the catalog', () => {
  it('every ADR file in assists/ loads through the catalog loader', async () => {
    const onDisk = fs
      .readdirSync(ASSISTS_DIR)
      .filter(f => f.startsWith('adr-') && f.endsWith('.md'))
      .map(f => f.slice(0, -'.md'.length))
      .sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(12);
    const loaded = (await adrRecords()).map(a => a.id);
    // The denominator check: a file the loader skips is invisible, and an
    // invisible ADR is the bug this whole unit exists to fix.
    expect(loaded).toEqual(onDisk);
  });

  it('get_assist returns the whole decision, not a title and a note', async () => {
    for (const a of await adrRecords()) {
      const body = await getAssist(a.id);
      expect(body, `${a.id} resolves`).not.toBeNull();
      expect(body!, `${a.id} has its Decision section`).toContain('## Decision');
      expect(body!, `${a.id} has its Consequences section`).toContain('## Consequences');
      expect(body!.length, `${a.id} is full text`).toBeGreaterThan(1500);
    }
  });

  it('each carries the kind and title an ADR record needs', async () => {
    for (const a of await adrRecords()) {
      expect(a.kind, `${a.id} is kind adr`).toBe('adr');
      expect(a.title, `${a.id} title names its number`).toMatch(/^ADR \d{4} [—-]/);
      expect(adrNumber(a.id), `${a.id} title number matches its id`).toBe(/ADR (\d{4})/.exec(a.title)![1]);
    }
  });
});

describe('#2607 — whenToUse makes each decision findable when an agent self-selects', () => {
  it('is written for a situation, not as a restatement of the title', async () => {
    const problems: string[] = [];
    for (const a of await adrRecords()) {
      if (a.whenToUse.trim().length < 80) {
        problems.push(`${a.id}: whenToUse is ${a.whenToUse.trim().length} chars — too thin to self-select on`);
      }
      const descriptive = a.title.replace(/^ADR \d{4}\s*[—-]\s*/, '').toLowerCase();
      if (descriptive && a.whenToUse.toLowerCase().includes(descriptive)) {
        problems.push(`${a.id}: whenToUse just repeats the title`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  /**
   * The real assertion. Each probe is phrased the way an agent describes its
   * OWN situation ("a subdomain doesn't resolve", "I'm about to add a
   * reconciler") — never as the ADR's title. The catalog ranks by token hits
   * across id/title/whenToUse/tags, so a whenToUse that says nothing about the
   * situation cannot win its own probe.
   */
  const PROBES: [string, string][] = [
    ['0001', 'service ships a local admin account and the oidc client secret stopped matching authelia after reinstall'],
    ['0002', 'where does this backup go, the nas or the bulk media drive'],
    ['0003', 'about to hand-edit a version number and the changelog for a release'],
    ['0004', 'this reinstall path wipes data, is a clean-install toggle allowed to reset other services'],
    ['0005', 'a service subdomain does not resolve to the box, the router hands out the wrong dns resolver'],
    ['0006', 'a forward-auth request to authelia returns no identity for the bare apex domain'],
    ['0007', 'may this pod set hostnetwork, and which address should it use to reach another service'],
    ['0008', 'changing an sb-tui stack panel keystroke that would redeploy an installed stack'],
    ['0009', 'minting an api token and scoping what one service may do to another'],
    ['0010', 'bumping node in the dockerfile and nvmrc, a native module fails with an abi mismatch'],
    ['0011', 'giving the companion app a second backend, a second token and another realtime connection'],
    ['0012', 'about to fix drifted credentials by redeploying, or add a self-heal reconciler loop'],
    ['0013', 'an agent asks me to mint it a token by hand, or a shipped tool never appears in any session because no token carries its scope'],
    ['0014', 'i merged an assist and get_assist on the box still says no such id, or i am about to add a second place assists are read from'],
    ['0015', 'a file i deleted from a template source tree is still on the node, and i am about to make the deploy clean up whatever the template no longer ships'],
  ];

  it('covers every ADR with a probe — no record gets a free pass', async () => {
    const nums = (await adrRecords()).map(a => adrNumber(a.id)).sort();
    expect(PROBES.map(p => p[0]).sort()).toEqual(nums);
  });

  it.each(PROBES)('ADR %s is the top-ranked decision for its own situation', async (num, query) => {
    const hits = (await listAssists({ query, kind: 'adr' })).filter(a => ADR_ID.test(a.id));
    const winner = hits[0];
    expect(winner, `no ADR matched "${query}"`).toBeDefined();
    expect(
      adrNumber(winner.id),
      `"${query}" ranked ${winner.id} first; ADR ${num} must win its own situation. ` +
        `Order: ${hits.slice(0, 3).map(h => h.id).join(' > ')}`,
    ).toBe(num);
  });

  /**
   * The probe above passes even on a vague line, because the catalog also
   * scores the id, the title and the tags — so a title that happens to share a
   * word with the query carries the match. That is exactly how "it's in the
   * catalog" can be true while the decision stays unfindable. This one scores
   * the `whenToUse` line ALONE: it fails unless that line, by itself, is the
   * thing that tells the twelve decisions apart.
   */
  it.each(PROBES)('ADR %s wins its situation on the whenToUse line ALONE', async (num, query) => {
    const tokens = [...new Set(query.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
    const scored = (await adrRecords())
      .map(a => ({
        id: a.id,
        hits: tokens.filter(t => a.whenToUse.toLowerCase().includes(t)).length,
      }))
      .sort((x, y) => y.hits - x.hits);

    const target = scored.find(s => adrNumber(s.id) === num)!;
    expect(target.hits, `ADR ${num}'s whenToUse answers nothing in "${query}"`).toBeGreaterThan(0);
    const rivals = scored.filter(s => s.id !== target.id);
    expect(
      target.hits,
      `ADR ${num}'s whenToUse (${target.hits} hits) does not beat ` +
        `${rivals[0].id} (${rivals[0].hits}) on "${query}" — the line does not say ` +
        'which situation this decision is for.',
    ).toBeGreaterThan(rivals[0].hits);
  });

  it('an ADR is reachable from a plain unqualified search too, not only kind-filtered', async () => {
    // An agent self-selecting does not know to pass kind='adr'.
    const hits = await listAssists({ query: 'may this container use hostNetwork or an isolated netns' });
    expect(hits.slice(0, 5).map(h => h.id)).toContain('adr-0007-container-network-isolation-and-carveouts');
  });
});

describe('#2607 — the old docs/adr paths still resolve', () => {
  it('every original ADR filename is still present as a signpost', () => {
    // These exact names appear in merged PR bodies, issue comments and code
    // comments; deleting one turns a historical reference into a 404.
    const expected = [
      '0001-authentication-via-authelia-sso-or-lldap.md',
      '0002-tiered-backup-nas-config-vs-bulk-drive.md',
      '0003-releases-via-release-please-only.md',
      '0004-installs-are-non-destructive.md',
      '0005-dns-topology-pattern-a.md',
      '0006-authelia-apex-deny-vs-wildcard.md',
      '0007-container-network-isolation-and-carveouts.md',
      '0008-tui-desired-state-and-journey.md',
      '0009-repair-is-reconciliation-not-reinstallation.md',
      '0009-service-tokens-and-trust.md',
      '0010-node-20-minor-floats.md',
      '0011-app-integrations-aggregate-server-side.md',
    ];
    for (const f of expected) {
      expect(fs.existsSync(path.join(ADR_DIR, f)), `docs/adr/${f} still resolves`).toBe(true);
    }
  });

  it('each signpost names an assist id that actually loads', async () => {
    for (const f of signpostFiles()) {
      const raw = fs.readFileSync(path.join(ADR_DIR, f), 'utf-8');
      const id = /`(adr-\d{4}-[a-z0-9-]+)`/.exec(raw)?.[1];
      expect(id, `docs/adr/${f} names its new home`).toBeDefined();
      expect(await getAssist(id!), `docs/adr/${f} points at a loadable assist`).not.toBeNull();
      expect(raw, `docs/adr/${f} names the tool that fetches it`).toContain('get_assist');
    }
  });

  it('holds no second copy of any decision — one copy, one place', () => {
    for (const f of signpostFiles()) {
      const raw = fs.readFileSync(path.join(ADR_DIR, f), 'utf-8');
      expect(raw, `docs/adr/${f} must not restate the decision`).not.toContain('## Decision');
      expect(raw.length, `docs/adr/${f} is a signpost, not a document`).toBeLessThan(2000);
    }
  });
});

describe('#2607 — orientation names the catalog as where decisions live', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf-8');

  it('CLAUDE.md points at the ADR assists, in orientation and in the assist section', () => {
    const md = read('CLAUDE.md');
    expect(md, 'orientation names the ADR assists').toContain('assists/adr-');
    expect(md, 'and says how to fetch one').toContain('get_assist');
    expect(md, 'and says where a NEW decision goes').toContain('adr-NNNN');
  });

  it('the docs that used to point at docs/adr now point at the catalog', () => {
    expect(read('docs', 'ARCHITECTURE_INVARIANTS.md')).toContain('assists/adr-');
    const index = read('docs', 'adr', 'README.md');
    expect(index).toContain('assist catalog');
    // The NEXT free number, not the highest taken one — 0014 is now spent
    // (#2701), so the index must advertise 0015. Matching a number that also
    // appears as an index row would pass vacuously.
    expect(index, 'names the next free number so the collision cannot recur')
      .toMatch(/Next free number:\s*\*\*0015\*\*/);
  });

  // #2701 / ADR 0014 INVERTED this: the image used to be how the ADRs (and the
  // rest of the catalog) reached a box, and that was the defect — an entry
  // merged with `docs(assists):` cuts no release, so it never arrived. The
  // catalog is delivered at runtime now, and a re-added COPY would be a SECOND
  // source that ages beside it.
  it('the image ships NO copy of the catalog — it is delivered at runtime', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile, 'no baked-in catalog').not.toMatch(/^\s*COPY .*\bassists\/?\s*$/m);
    expect(dockerfile, 'no second copy is shipped').not.toMatch(/^COPY .*docs\/adr/m);
    expect(dockerfile, 'and the Dockerfile says why, so the COPY does not come back')
      .toMatch(/delivered at runtime|DELIVERED AT RUNTIME/i);
  });
});
