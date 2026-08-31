/**
 * Service-repo bootstrap step (#2513).
 *
 * The gap this closes is not "no standard existed" — `get_service_standards` was
 * already a good index. It is that **consulting it was not a step anywhere**, so
 * a sibling repo chose its stack, CI and storage before ever meeting the ADRs.
 *
 * What must therefore hold, and is asserted here:
 *   1. The tool serves a `repoBootstrap` block with the finished CLAUDE.md text
 *      (both flavors — the repo that failed was bootstrapped with `generic`).
 *   2. The pasteable copy in the `create-service` recipe is byte-identical to
 *      the generator, so the three copies (module / tool / recipe) can't drift.
 *   3. The `check`/`write` mechanics really fail a repo without the pointer —
 *      including the RED path of the `check:arch` invariant.
 *   4. The MCP initialize instructions name the tool, which is the one channel
 *      that reaches a client before its first tool call.
 *
 * Pure file-system + parsing. No agent / network needed.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  BOOTSTRAP_MARKER_BEGIN,
  BOOTSTRAP_MARKER_END,
  BOOTSTRAP_REQUIRED_REFERENCES,
  BOOTSTRAP_STEP,
  applyStandardsPointer,
  checkStandardsPointer,
  renderStandardsPointerBlock,
} from '@/lib/mcp/serviceRepoBootstrap';
import { buildServiceStandards } from '@/lib/mcp/serviceStandards';
import { auditServiceRepoBootstrap } from '../../scripts/check-invariants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CREATE_SERVICE = path.join(REPO_ROOT, 'assists', 'create-service.md');

describe('standards pointer block (#2513)', () => {
  it('names the tool, the assist fetch and the gap-report convention', () => {
    const block = renderStandardsPointerBlock();
    for (const ref of BOOTSTRAP_REQUIRED_REFERENCES) {
      expect(block, `pointer block mentions ${ref}`).toContain(ref);
    }
    expect(block.startsWith(BOOTSTRAP_MARKER_BEGIN)).toBe(true);
    expect(block.endsWith(BOOTSTRAP_MARKER_END)).toBe(true);
  });

  it('tells an unconnected session to stop rather than guess', () => {
    // The foundry-chronicle failure was invisible precisely because the session
    // had no ServiceBay MCP and carried on regardless.
    expect(renderStandardsPointerBlock()).toMatch(/not connected[\s\S]*stop and say so/i);
    expect(BOOTSTRAP_STEP.ifMcpNotConnected).toMatch(/connect/i);
  });

  it('checkStandardsPointer rejects a CLAUDE.md with no pointer', () => {
    const res = checkStandardsPointer('# My new service\n\nSome notes.\n');
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/standards:bootstrap/);
  });

  it('checkStandardsPointer rejects an edited (drifted) block', () => {
    const drifted = applyStandardsPointer('# repo\n').replace('Read first, design second', 'whatever you like');
    const res = checkStandardsPointer(drifted);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/drifted/);
  });

  it('applyStandardsPointer is idempotent and preserves the rest of the file', () => {
    const original = '# My new service\n\nSome notes.\n';
    const once = applyStandardsPointer(original);
    expect(checkStandardsPointer(once).ok).toBe(true);
    expect(once).toContain('Some notes.');
    expect(applyStandardsPointer(once)).toBe(once);
    // A file that already carries a stale block is refreshed in place, not doubled.
    const stale = once.replace('Read first, design second', 'Read whenever');
    const refreshed = applyStandardsPointer(stale);
    expect(checkStandardsPointer(refreshed).ok).toBe(true);
    expect(refreshed.split(BOOTSTRAP_MARKER_BEGIN).length - 1).toBe(1);
  });

  it('bootstraps an empty/absent CLAUDE.md', () => {
    expect(checkStandardsPointer(applyStandardsPointer('')).ok).toBe(true);
  });

  // #2701 — hole 1: the block used to name only the servicebay flavor's
  // `assistsToRead`, while the cross-repo working agreements hang off the
  // GENERIC flavor's `workingAgreements`. A repo that installed the block and
  // followed it exactly never learned they existed.
  it('sends the reader to BOTH flavors, so the working agreements are reachable', async () => {
    const block = renderStandardsPointerBlock('servicebay');
    expect(block).toContain('get_service_standards(flavor="servicebay")');
    expect(block).toContain('get_service_standards(flavor="generic")');
    expect(block).toContain('workingAgreements');

    // …and the ids it promises are actually served by that flavor.
    const generic = await buildServiceStandards('generic');
    const wa = generic.workingAgreements as { ids: { id: string }[] };
    expect(wa.ids.length).toBeGreaterThan(0);
    expect(block).toContain(wa.ids[0].id);
  });

  // #2701 — hole 2: the generic flavor had step/ifServiceBayTarget/
  // ifMcpNotConnected and NO pasteable block at all.
  it('renders a generic flavor block that points at the working agreements', () => {
    const block = renderStandardsPointerBlock('generic');
    expect(block.startsWith(BOOTSTRAP_MARKER_BEGIN)).toBe(true);
    expect(block.endsWith(BOOTSTRAP_MARKER_END)).toBe(true);
    for (const ref of BOOTSTRAP_REQUIRED_REFERENCES) {
      expect(block, `generic pointer block mentions ${ref}`).toContain(ref);
    }
    expect(block).toContain('get_service_standards(flavor="generic")');
    expect(block).not.toBe(renderStandardsPointerBlock('servicebay'));
  });

  it('accepts either flavor when none is named, and pins one when it is', () => {
    const generic = applyStandardsPointer('# repo\n', 'generic');
    expect(checkStandardsPointer(generic).ok).toBe(true);
    expect(checkStandardsPointer(generic, 'generic').ok).toBe(true);
    // A servicebay-targeting repo carrying the generic block is drift, and the
    // check says so once the flavor is named.
    const res = checkStandardsPointer(generic, 'servicebay');
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/drifted/);
  });
});

describe('get_service_standards serves the bootstrap step (#2513)', () => {
  it('servicebay flavor returns the finished CLAUDE.md block, not an instruction to write one', async () => {
    const s = await buildServiceStandards('servicebay');
    const rb = s.repoBootstrap as { claudeMdBlock: string; commands: string[]; step: string; ifMcpNotConnected: string };
    expect(rb).toBeDefined();
    expect(rb.claudeMdBlock).toBe(renderStandardsPointerBlock());
    expect(rb.commands.join(' ')).toContain('standards:bootstrap');
    expect(rb.step).toMatch(/before/i);
    expect(rb.ifMcpNotConnected).toBeTruthy();
  });

  it('generic flavor carries the ServiceBay-target detection step', async () => {
    // The repo that shipped past the ADRs was bootstrapped with the GENERIC
    // standards — a generic flavor with no route to the platform flavor is a
    // dead end for exactly the case that failed.
    const s = await buildServiceStandards('generic');
    const rb = s.repoBootstrap as { ifServiceBayTarget: string; claudeMdBlock: string };
    expect(rb).toBeDefined();
    expect(rb.ifServiceBayTarget).toContain('get_service_standards');
    expect(rb.ifServiceBayTarget).toContain('servicebay');
    // #2701: and it now hands over the finished text, like the servicebay flavor.
    expect(rb.claudeMdBlock).toBe(renderStandardsPointerBlock('generic'));
    // …without smuggling the platform ADR list into the generic flavor (#2323).
    expect(s.mustRespectAdrs).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('docs/adr');
  });
});

describe('the pasteable copies cannot drift (#2513)', () => {
  it('the create-service recipe embeds the generated block byte-for-byte', () => {
    const doc = fs.readFileSync(CREATE_SERVICE, 'utf-8');
    const start = doc.indexOf(BOOTSTRAP_MARKER_BEGIN);
    const end = doc.indexOf(BOOTSTRAP_MARKER_END);
    expect(start, 'create-service.md carries the pointer block').toBeGreaterThanOrEqual(0);
    expect(doc.slice(start, end + BOOTSTRAP_MARKER_END.length)).toBe(renderStandardsPointerBlock());
  });

  it('check:arch passes on the real recipe', () => {
    expect(auditServiceRepoBootstrap(fs.readFileSync(CREATE_SERVICE, 'utf-8'))).toEqual([]);
  });

  it('check:arch fails when the bootstrap step is demoted or the block deleted', () => {
    const doc = fs.readFileSync(CREATE_SERVICE, 'utf-8');

    // Someone re-orders the recipe so "Image" is step 1 again.
    const demoted = doc.replace(
      /\n## Ordered actions\n[\s\S]*?(?=\n## )/,
      '\n## Ordered actions\n1. **Image** — build + push it.\n2. **Install** — go.\n',
    );
    expect(auditServiceRepoBootstrap(demoted).join(' ')).toMatch(/FIRST ordered action/);

    // Someone drops the pointer block.
    const stripped = doc.replace(BOOTSTRAP_MARKER_BEGIN, 'x').replace(BOOTSTRAP_MARKER_END, 'x');
    expect(auditServiceRepoBootstrap(stripped).join(' ')).toMatch(/no longer carries/);
  });
});

// The initialize-handshake half of the loop is asserted end-to-end through the
// SDK in packages/backend/src/lib/mcp/server.test.ts ("tells a new-project
// session to call get_service_standards first").
