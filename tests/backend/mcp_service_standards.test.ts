/**
 * get_service_standards MCP tool (#2323).
 *
 * Covers both flavors of the curated standards index:
 *   - servicebay: the four blocks (mustRespectAdrs / enforcedInvariants /
 *     assistsToRead / templateContract), with the ADRs read live from the
 *     assist catalog (#2607) so their titles can't drift from the source and
 *     every pointer is followable with get_assist(id).
 *   - generic: platform-agnostic dev standards with NO ServiceBay ADRs or
 *     template details.
 * Plus the read scope and that the referenced assist ids actually resolve.
 *
 * Pure file-system + parsing (process.cwd() is the repo root under vitest). No
 * agent / network needed.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  buildServiceStandards,
  scanCuratedAdrs,
  SERVICE_STANDARDS_FLAVORS,
} from '@/lib/mcp/serviceStandards';
import { TOOL_SCOPES } from '@/lib/mcp/server';
import { getAssist, listAssists } from '@/lib/assists/catalog';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('get_service_standards scope (#2323)', () => {
  it('is registered as a read-scoped tool', () => {
    expect(TOOL_SCOPES.get_service_standards).toBe('read');
  });

  it('exposes exactly the two documented flavors', () => {
    expect([...SERVICE_STANDARDS_FLAVORS]).toEqual(['servicebay', 'generic']);
  });
});

describe('get_service_standards — servicebay flavor (#2323)', () => {
  it('returns the four curated blocks', async () => {
    const s = await buildServiceStandards('servicebay');
    expect(s.flavor).toBe('servicebay');
    expect(s.mustRespectAdrs).toBeDefined();
    expect(s.enforcedInvariants).toBeDefined();
    expect(s.assistsToRead).toBeDefined();
    expect(s.templateContract).toBeDefined();
  });

  it('mustRespectAdrs covers EVERY ADR, not a curated six (#2607)', async () => {
    const s = await buildServiceStandards('servicebay');
    const adrs = s.mustRespectAdrs as { adr: string; assist: string }[];
    // The denominator is the catalog itself: an ADR that exists but is absent
    // from this list is exactly the #2607 failure (0011 appeared in no answer).
    const catalogNumbers = (await listAssists({ kind: 'adr' }))
      .map(a => /^adr-(\d{4})-/.exec(a.id)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
    expect(catalogNumbers.length).toBeGreaterThanOrEqual(12);
    expect(adrs.map(a => a.adr)).toEqual(catalogNumbers);
    // The six that used to be the whole answer are still in it.
    for (const n of ['0001', '0003', '0004', '0007', '0009', '0010']) {
      expect(adrs.map(a => a.adr), `still covers ADR ${n}`).toContain(n);
    }
    // …and so are the ones that never used to appear at all.
    expect(adrs.map(a => a.adr)).toContain('0011');
  });

  it('every mustRespectAdrs pointer is FOLLOWABLE — full text via get_assist', async () => {
    const s = await buildServiceStandards('servicebay');
    const adrs = s.mustRespectAdrs as { adr: string; title: string; note: string; assist: string; fetch: string }[];
    for (const a of adrs) {
      const body = await getAssist(a.assist);
      expect(body, `ADR ${a.adr} resolves via get_assist("${a.assist}")`).not.toBeNull();
      // Full text, not a title + one-liner (the #2607 complaint).
      expect(body!, `ADR ${a.adr} carries its Decision section`).toContain('## Decision');
      expect(a.fetch).toBe(`get_assist("${a.assist}")`);
      expect(a.title.length).toBeGreaterThan(0);
      // Title comes from the record, not from a hard-coded copy here.
      expect(body!).toContain(a.title);
      expect(a.note.trim().length).toBeGreaterThan(0);
    }
    // The pointer no longer names a path no MCP tool can open.
    expect(JSON.stringify(adrs)).not.toContain('docs/adr');
  });

  it('resolves the 0009 slot to the tokens-and-trust ADR, not repair (#2617)', async () => {
    const s = await buildServiceStandards('servicebay');
    const adrs = s.mustRespectAdrs as { adr: string; assist: string }[];
    expect(adrs.filter(a => a.adr === '0009')).toHaveLength(1);
    expect(adrs.find(a => a.adr === '0009')?.assist).toContain('service-tokens');
    // Repair-is-reconciliation kept its content and lost the duplicate number.
    expect(adrs.find(a => a.adr === '0012')?.assist).toContain('repair-is-reconciliation');
  });

  it('tells the caller how to reach the ADRs WITHOUT this tool (#2607)', async () => {
    const s = await buildServiceStandards('servicebay');
    const block = s.adrCatalog as { note: string; listCall: string; count: number };
    // get_service_standards' own entry condition is "building a new service";
    // whoever fixes a probe never calls it, so the catalog route must be named.
    expect(block.listCall).toContain('list_assists');
    expect(block.note).toContain('get_assist');
    expect(block.count).toBe((s.mustRespectAdrs as unknown[]).length);
  });

  it('enforcedInvariants points at ARCHITECTURE_INVARIANTS and carries the gate commands', async () => {
    const s = await buildServiceStandards('servicebay');
    const inv = s.enforcedInvariants as { pointer: string; gateCommands: string[]; diffCoverageFloor: string };
    expect(inv.pointer).toBe('docs/ARCHITECTURE_INVARIANTS.md');
    expect(inv.gateCommands.join(' ')).toContain('npm run check:arch');
    expect(inv.gateCommands.join(' ')).toContain('npm run lint');
    expect(inv.diffCoverageFloor).toContain('70');
  });

  it('templateContract points at the authoring doc + template contract', async () => {
    const s = await buildServiceStandards('servicebay');
    const tc = s.templateContract as { pointers: string[] };
    expect(tc.pointers).toContain('docs/TEMPLATE_AUTHORING.md');
    expect(tc.pointers).toContain('templates/CLAUDE.md');
  });

  it('every assistsToRead id resolves via get_assist', async () => {
    const s = await buildServiceStandards('servicebay');
    const block = s.assistsToRead as { ids: { id: string }[] };
    for (const { id } of block.ids) {
      const body = await getAssist(id);
      expect(body, `assist "${id}" resolves`).not.toBeNull();
    }
    // The single-source backing checklist itself is resolvable.
    expect(await getAssist('new-service-standards')).not.toBeNull();
  });

  it('surfaces the service-builder standards-gap fixes (#2344 #2345)', async () => {
    const s = await buildServiceStandards('servicebay');
    const block = s.assistsToRead as { ids: { id: string }[] };
    const ids = block.ids.map(i => i.id);
    // #2345 testing/CI-gate + #2344 gaps are all wired into the index.
    for (const id of [
      'testing-and-ci-gate',
      'long-running-process',
      'data-authority',
      'recipe-roll-new-image-to-running-service',
      'report-standards-gaps',
      'footgun-cross-service-uid-writes',
      'footgun-local-template-write-uid',
    ]) {
      expect(ids, `assistsToRead includes ${id}`).toContain(id);
    }
    // The 'report gaps back' convention is surfaced at build start.
    const rg = s.reportGapsBack as { assist: string; note: string };
    expect(rg.assist).toBe('report-standards-gaps');
    expect(rg.note).toContain('standards-gap');
    // The build-gates-on-tests + 85% expectation is recorded on the invariants block.
    const inv = s.enforcedInvariants as { testGate: string };
    expect(inv.testGate).toContain('needs: test');
    expect(inv.testGate).toContain('85%');
  });
});

describe('UI language & state design is a standard (#2514)', () => {
  it('is reachable through get_service_standards and resolves', async () => {
    // The sibling frontend that shipped CLI commands as status texts had read
    // every standard the catalog served — none of them covered what the UI SAYS.
    const s = await buildServiceStandards('servicebay');
    const ids = (s.assistsToRead as { ids: { id: string; why: string }[] }).ids;
    const entry = ids.find(i => i.id === 'service-ui-user-language');
    expect(entry, 'assistsToRead surfaces service-ui-user-language').toBeDefined();
    expect(entry!.why).toMatch(/language/i);
    expect(await getAssist('service-ui-user-language')).not.toBeNull();
  });

  it('references the existing UX philosophy instead of restating it', async () => {
    const body = (await getAssist('service-ui-user-language')) ?? '';
    // Prior art in this repo — the standard points at it, it is not a parallel
    // second version of the same principle.
    expect(body).toContain('docs/UX_PHILOSOPHY.md');
    expect(body).toContain('docs/UX_DECISIONS.md');
    expect(fs.existsSync(path.join(REPO_ROOT, 'docs', 'UX_PHILOSOPHY.md'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'docs', 'UX_DECISIONS.md'))).toBe(true);
  });

  it('carries the rules the sibling frontend violated, incl. test enforcement', async () => {
    const body = (await getAssist('service-ui-user-language')) ?? '';
    // Every rejection from the #2514 review maps to a rule here.
    expect(body, 'CLI/env/header names banned in rendered HTML').toMatch(/env-var names/i);
    expect(body).toMatch(/header names/i);
    expect(body, 'the ban is test-enforced, not a review habit').toMatch(/test-enforced|not a review habit/i);
    expect(body, 'an untriggerable named action is a product gap').toMatch(/product gap/i);
    expect(body, 'onboarding shows while its condition holds').toMatch(/condition the wizard resolves|not only on virgin state/i);
    expect(body, 'settings group by user questions').toMatch(/group by user questions|Settings group by/i);
  });

  it('is cross-linked from the design standard, which was the doc that was silent', async () => {
    const design = (await getAssist('service-ui-design-standard')) ?? '';
    expect(design).toContain('service-ui-user-language');
  });
});

describe('journal retention is a documented standard, not tribal knowledge (#2659)', () => {
  it('is reachable through get_service_standards and resolves', async () => {
    const s = await buildServiceStandards('servicebay');
    const ids = (s.assistsToRead as { ids: { id: string; why: string }[] }).ids;
    const entry = ids.find(i => i.id === 'footgun-journal-is-a-buffer-not-an-archive');
    expect(entry, 'assistsToRead surfaces the journal-retention footgun').toBeDefined();
    expect(entry!.why).toMatch(/durable log/i);
    expect(await getAssist('footgun-journal-is-a-buffer-not-an-archive')).not.toBeNull();
  });

  it('states the journal retention behaviour and names the actual knobs (#2659)', async () => {
    const body = (await getAssist('footgun-journal-is-a-buffer-not-an-archive')) ?? '';
    // #2659 bullet 1: retention is a set value, not an assumed calendar window,
    // and the knobs + where to find the real number are named.
    expect(body).toContain('SystemMaxUse');
    expect(body).toContain('MaxRetentionSec');
    expect(body).toMatch(/journald\.conf/);
    expect(body, 'names the disk-usage check, not just the config keys').toContain('journalctl --disk-usage');
  });

  it('states the durable-logging rule (#2659)', async () => {
    const body = (await getAssist('footgun-journal-is-a-buffer-not-an-archive')) ?? '';
    // #2659 bullet 2: a service whose actions must be reconstructable later
    // writes its own durable log — the journal is a buffer, not an archive.
    expect(body).toMatch(/writes its own\s+durable log/i);
    expect(body).toMatch(/buffer, not an? archive/i);
  });

  it('cross-references the journal-measurement footgun instead of duplicating it', async () => {
    const body = (await getAssist('footgun-journal-is-a-buffer-not-an-archive')) ?? '';
    expect(body).toContain('footgun-journal-conmon-is-not-a-second-emitter.md');
    expect(await getAssist('footgun-journal-conmon-is-not-a-second-emitter')).not.toBeNull();
  });
});

describe('get_service_standards — generic flavor (#2323)', () => {
  it('returns platform-agnostic standards', async () => {
    const s = await buildServiceStandards('generic');
    expect(s.flavor).toBe('generic');
    const std = s.standards as Record<string, string>;
    expect(std.commitConvention).toBeTruthy();
    expect(std.releaseDiscipline).toBeTruthy();
    expect(std.testAndCoverage).toContain('70');
    expect(std.secretHygiene).toBeTruthy();
    expect(std.scriptsOverProse).toBeTruthy();
  });

  it('carries NO ServiceBay ADRs or template details', async () => {
    const s = await buildServiceStandards('generic');
    expect(s.mustRespectAdrs).toBeUndefined();
    expect(s.templateContract).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('docs/adr');
  });

  it('points at its single-source backing assist, which resolves', async () => {
    const s = await buildServiceStandards('generic');
    expect(s.fullTextAssist).toBe('generic-project-standards');
    expect(await getAssist('generic-project-standards')).not.toBeNull();
  });
});

describe('scanCuratedAdrs (#2323, widened by #2607)', () => {
  it('returns every ADR in ascending order, each with a title', async () => {
    const adrs = await scanCuratedAdrs();
    expect(adrs.length).toBeGreaterThanOrEqual(12);
    for (const a of adrs) expect(a.title.length).toBeGreaterThan(0);
    expect(adrs.map(a => a.adr)).toEqual([...adrs.map(a => a.adr)].sort());
  });

  it('numbers are unique — no two records claim the same ADR number (#2617)', async () => {
    const nums = (await scanCuratedAdrs()).map(a => a.adr);
    expect(new Set(nums).size, `duplicate ADR number in ${nums.join(',')}`).toBe(nums.length);
  });
});
