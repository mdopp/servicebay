/**
 * get_service_standards MCP tool (#2323).
 *
 * Covers both flavors of the curated standards index:
 *   - servicebay: the four blocks (mustRespectAdrs / enforcedInvariants /
 *     assistsToRead / templateContract), with ADR titles scanned live from
 *     docs/adr/*.md so they can't drift from the source.
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
import { getAssist } from '@/lib/assists/catalog';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');

/** Pull the descriptive title from an ADR file's `# ADR NNNN — <title>` head. */
function adrTitleFromFile(file: string): string {
  const raw = fs.readFileSync(path.join(ADR_DIR, file), 'utf-8');
  const line = raw.split('\n').find(l => /^#\s+/.test(l)) ?? '';
  return line.replace(/^#\s+/, '').replace(/^ADR\s+\d{4}\s*[—-]\s*/, '').trim();
}

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

  it('mustRespectAdrs titles match docs/adr/*.md exactly (drift-free)', async () => {
    const s = await buildServiceStandards('servicebay');
    const adrs = s.mustRespectAdrs as { adr: string; title: string; path: string }[];
    // The curated selection required by the issue.
    expect(adrs.map(a => a.adr)).toEqual(['0001', '0003', '0004', '0007', '0009', '0010']);

    for (const a of adrs) {
      const file = path.basename(a.path);
      expect(fs.existsSync(path.join(ADR_DIR, file)), `ADR file exists: ${file}`).toBe(true);
      // Title is scanned from the source, not hard-coded.
      expect(a.title).toBe(adrTitleFromFile(file));
    }
  });

  it('resolves the 0009 slot to the tokens-and-trust ADR, not repair', async () => {
    const s = await buildServiceStandards('servicebay');
    const adrs = s.mustRespectAdrs as { adr: string; path: string }[];
    const nine = adrs.find(a => a.adr === '0009');
    expect(nine?.path).toContain('service-tokens');
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

describe('scanCuratedAdrs (#2323)', () => {
  it('never returns an empty selection', async () => {
    const adrs = await scanCuratedAdrs();
    expect(adrs.length).toBe(6);
    for (const a of adrs) expect(a.title.length).toBeGreaterThan(0);
  });
});
