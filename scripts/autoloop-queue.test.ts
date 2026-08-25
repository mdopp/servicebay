/**
 * Autoloop state-broker tests (#2639).
 *
 * The centre of gravity is the CLAIM. The whole reason `work-queue.json` was
 * retired is that its claim lived in a local file, so two loop instances could
 * grab the same issue. A replacement whose claim merely *usually* wins is worse
 * than the file it replaces — so the claim protocol is tested three ways:
 *
 *   1. unit — the only thing that grants a claim is a successful atomic ref
 *      create; a conflict AND a transport error both fail CLOSED, and neither
 *      is allowed to reach the `autoloop:building` label call;
 *   2. structural — the label is a projection, never the lock (an
 *      `issue edit --add-label` may only follow a won ref);
 *   3. concurrency — six REAL processes, each with its own cache (i.e. six loop
 *      instances), race one unit against a `gh` stub whose ref store is backed
 *      by POSIX `mkdir` (the same create-if-not-exists semantics GitHub's
 *      `POST /git/refs` gives: HTTP 422 "Reference already exists", verified
 *      live against this repo on 2026-08-25). Exactly one may win.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  Cache,
  CACHE_VERSION,
  L_BUILDING,
  L_QUEUED,
  L_VERIFY_FAILED,
  L_VERIFY_PENDING,
  NOTES_CAP,
  PARK_LABELS,
  TEXT_MAX,
  acquireClaim,
  batchIssueCount,
  claimRef,
  clip,
  freshCache,
  parkUnits,
  pruneState,
  runVerb,
  verifyLabels,
  type CacheState,
  type GhRunner,
  type Unit,
} from './autoloop-queue';

const REPO_ROOT = path.resolve(__dirname, '..');

/** A recording `gh` whose per-call verdict the test controls. */
function fakeGh(verdict: (args: string[]) => { ok: boolean; out: string } = () => ({ ok: true, out: '' })) {
  const calls: string[][] = [];
  const gh: GhRunner = args => {
    calls.push(args);
    return verdict(args);
  };
  return { gh, calls };
}
const isRefCreate = (a: string[]) => a[0] === 'api' && a.includes('POST') && a.some(x => x.endsWith('/git/refs'));
const isRefDelete = (a: string[]) => a[0] === 'api' && a.includes('DELETE') && a.some(x => x.includes('/git/refs/'));
const isLabelAdd = (a: string[]) => a.includes('issue') && a.includes('--add-label');

describe('claim — the cross-instance lock', () => {
  it('is granted ONLY by the atomic ref create, and the label follows it', () => {
    const { gh, calls } = fakeGh();
    const r = acquireClaim([2639], gh, { sha: 'abc' });
    expect(r.ok).toBe(true);
    // First call must be the create-if-not-exists; the label projection is after.
    expect(isRefCreate(calls[0])).toBe(true);
    expect(calls[0]).toContain(`ref=${claimRef(2639)}`);
    const labelIdx = calls.findIndex(isLabelAdd);
    expect(labelIdx).toBeGreaterThan(0);
    expect(calls[labelIdx]).toContain(L_BUILDING);
  });

  it('fails CLOSED on a conflict — and never touches the building label', () => {
    // GitHub's real conflict shape for an existing ref.
    const { gh, calls } = fakeGh(a =>
      isRefCreate(a) ? { ok: false, out: 'Reference already exists (HTTP 422)' } : { ok: true, out: '' },
    );
    const r = acquireClaim([2639], gh, { sha: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.lostOn).toBe(2639);
    // THE mutation guard: a lost claim must not reach the label, and must not
    // report a win. Flipping the `if (!res.ok)` guard turns this red.
    expect(calls.some(isLabelAdd)).toBe(false);
    expect(r.won).toEqual([]);
  });

  it('fails CLOSED on a transport error too (an unproven claim is not a claim)', () => {
    const { gh, calls } = fakeGh(a => (isRefCreate(a) ? { ok: false, out: 'dial tcp: i/o timeout' } : { ok: true, out: '' }));
    expect(acquireClaim([2639], gh, { sha: 'abc' }).ok).toBe(false);
    expect(calls.some(isLabelAdd)).toBe(false);
  });

  it('claims a cluster all-or-nothing: a partial win is rolled back', () => {
    // Two instances racing a cluster: we win #10, lose #20.
    const { gh, calls } = fakeGh(a =>
      isRefCreate(a) && a.some(x => x.endsWith('/20'))
        ? { ok: false, out: 'Reference already exists (HTTP 422)' }
        : { ok: true, out: '' },
    );
    const r = acquireClaim([20, 10], gh, { sha: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.won).toEqual([]);
    // #10 must be given back, or both instances deadlock holding half a cluster.
    expect(calls.filter(isRefDelete).some(a => a.some(x => x.endsWith('/10')))).toBe(true);
    expect(calls.some(isLabelAdd)).toBe(false);
  });

  it('claims in ascending issue order so racers collide on the same ref first', () => {
    const { gh, calls } = fakeGh();
    acquireClaim([30, 10, 20], gh, { sha: 'abc' });
    const created = calls.filter(isRefCreate).map(a => a.find(x => x.startsWith('ref='))!);
    expect(created).toEqual([`ref=${claimRef(10)}`, `ref=${claimRef(20)}`, `ref=${claimRef(30)}`]);
  });
});

describe('claim — six concurrent loop instances (the double-claim proof)', () => {
  const INSTANCES = 6;

  it('lets exactly ONE instance win, and only that one labels the issue', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'autoloop-claim-'));
    const store = path.join(root, 'refs'); // the shared "GitHub" ref namespace
    const log = path.join(root, 'gh.log');
    mkdirSync(store, { recursive: true });
    writeFileSync(log, '');

    // A `gh` stub. `mkdir` is atomic create-if-not-exists on POSIX — the same
    // contract GitHub's POST /git/refs offers (422 when the ref exists).
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghStub = path.join(bin, 'gh');
    writeFileSync(
      ghStub,
      [
        '#!/usr/bin/env bash',
        `echo "$@" >> ${JSON.stringify(log)}`,
        'if [[ "$1" == "api" && "$*" == *"POST"* && "$*" == *"/git/refs"* ]]; then',
        '  for a in "$@"; do [[ "$a" == ref=* ]] && REF="${a#ref=}"; done',
        `  mkdir ${JSON.stringify(store)}/"\${REF//\\//_}" 2>/dev/null || {`,
        '    echo "Reference already exists (HTTP 422)" >&2; exit 1; }',
        '  exit 0',
        'fi',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(ghStub, 0o755);

    const unit: Unit = { id: 'u1', kind: 'issue', issues: [2639], status: 'planned' };
    const runs = Array.from({ length: INSTANCES }, (_, i) => {
      // Each instance gets its OWN cache — that is what a second loop instance
      // is, and exactly the case the old local-file claim could not survive.
      const cachePath = path.join(root, `cache-${i}.json`);
      const c = new Cache(cachePath);
      const d = freshCache();
      d.units.u1 = { ...unit };
      c.save(d);
      return cachePath;
    });

    const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const script = path.join(REPO_ROOT, 'scripts', 'autoloop-queue.ts');
    // Start them as close to simultaneously as possible, then collect.
    const procs = runs.map(cachePath =>
      spawnSync(
        tsx,
        [script, '--cache', cachePath, '--repo', 'mdopp/servicebay', 'claim', 'u1'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          timeout: 60_000,
        },
      ),
    );

    const winners = procs.filter(p => p.status === 0);
    const losers = procs.filter(p => p.status === 3);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(INSTANCES - 1);
    expect(winners[0].stdout).toContain('claimed u1');
    for (const l of losers) expect(l.stdout).toContain('held by another loop instance');

    // Exactly one ref exists, and the label was projected exactly once.
    expect(readdirSync(store)).toEqual([claimRef(2639).replaceAll('/', '_')]);
    const ghLog = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(ghLog.filter(l => l.includes('--add-label') && l.includes(L_BUILDING))).toHaveLength(1);
  }, 90_000);
});

describe('cache — caps and pruning are enforced in code', () => {
  let cache: Cache;
  beforeEach(() => {
    cache = new Cache(path.join(mkdtempSync(path.join(tmpdir(), 'autoloop-cache-')), 'cache.json'));
  });

  it('round-trips a fresh cache at the current version', () => {
    const d = cache.load();
    expect(d.version).toBe(CACHE_VERSION);
    d.last_invocation = 42;
    cache.save(d);
    expect(cache.load().last_invocation).toBe(42);
  });

  it('treats a corrupt cache as fresh (it is never the source of truth)', () => {
    writeFileSync(cache.path, '{not json');
    expect(cache.load()).toEqual(freshCache());
  });

  it('caps the notes ring', () => {
    const d = freshCache();
    d.notes = Array.from({ length: NOTES_CAP + 20 }, (_, i) => ({ note: String(i), since: i }));
    cache.save(d);
    expect(cache.load().notes).toHaveLength(NOTES_CAP);
  });

  it('drops finished units — GitHub is the durable record', () => {
    const d = freshCache();
    d.units = { a: { id: 'a', status: 'done' }, b: { id: 'b', status: 'planned' } };
    expect(Object.keys(pruneState(d).units)).toEqual(['b']);
  });

  it('marks what it clipped rather than truncating silently', () => {
    expect(clip('short')).toBe('short');
    const clipped = clip('x'.repeat(TEXT_MAX + 37));
    expect(clipped).toContain('37 chars dropped');
    expect(clipped.startsWith('x'.repeat(TEXT_MAX))).toBe(true);
  });
});

describe('verbs — batch, verify, park', () => {
  let cache: Cache;
  let calls: string[][];
  let out: string[];
  let ctx: Parameters<typeof runVerb>[2];

  const seed = (units: Record<string, Unit>, batch: CacheState['batch'] = null) => {
    const d = freshCache();
    d.units = units;
    d.batch = batch;
    cache.save(d);
  };

  beforeEach(() => {
    cache = new Cache(path.join(mkdtempSync(path.join(tmpdir(), 'autoloop-verb-')), 'cache.json'));
    const f = fakeGh();
    calls = f.calls;
    out = [];
    ctx = { cache, gh: f.gh, offline: false, sha: () => 'deadbee', now: () => 1_000_000, out: s => out.push(s) };
  });

  it('counts the batch in ISSUES, not units (a cluster carries several)', () => {
    seed({ u1: { id: 'u1', issues: [1], status: 'planned' }, c1: { id: 'c1', issues: [2, 3], status: 'planned' } });
    runVerb('batch', ['new', '--branch', 'batch/x'], ctx);
    runVerb('built', ['u1'], ctx);
    runVerb('built', ['c1'], ctx);
    expect(cache.load().batch).toMatchObject({ unit_ids: ['u1', 'c1'], count: 3 });
  });

  it('counts a security unit on the batch (ServiceBay ships them in-batch, flagged post-deploy)', () => {
    seed({ s1: { id: 's1', issues: [7], status: 'planned', security: true } });
    runVerb('batch', ['new', '--branch', 'batch/x'], ctx);
    runVerb('built', ['s1'], ctx);
    expect(cache.load().batch?.count).toBe(1);
  });

  it('batch reset releases the shipped units claims and drops them', () => {
    seed({ u1: { id: 'u1', issues: [11], status: 'built' } }, { branch: 'batch/x', count: 1, unit_ids: ['u1'] });
    runVerb('batch', ['reset'], ctx);
    expect(cache.load().batch).toBeNull();
    expect(cache.load().units.u1).toBeUndefined();
    expect(calls.filter(isRefDelete).some(a => a.some(x => x.endsWith('/11')))).toBe(true);
  });

  it('park takes the unit out of rotation, releases its claim, and labels the issue', () => {
    seed({ u1: { id: 'u1', issues: [99], status: 'planned' }, u2: { id: 'u2', issues: [88], status: 'planned' } });
    expect(runVerb('park', ['99', 'refinement', '--comment', 'A or B?'], ctx)).toBe(0);
    expect(cache.load().units.u1.status).toBe('parked');
    expect(cache.load().units.u2.status).toBe('planned'); // untouched
    runVerb('next', [], ctx);
    expect(JSON.parse(out.at(-1)!).id).toBe('u2');
    expect(calls.some(a => a.includes('--add-label') && a.includes(PARK_LABELS.refinement))).toBe(true);
    expect(calls.filter(isRefDelete).some(a => a.some(x => x.endsWith('/99')))).toBe(true);
    expect(calls.some(a => a.includes('comment'))).toBe(true);
  });

  it('rejects an unknown park state instead of silently mislabelling', () => {
    seed({});
    expect(runVerb('park', ['99', 'whatever'], ctx)).toBe(2);
  });

  it('parkUnits leaves built units alone (a shipped unit is not un-shipped)', () => {
    const d = freshCache();
    d.units = { u1: { id: 'u1', issues: [5], status: 'built' } };
    expect(parkUnits(d, 5)).toEqual([]);
  });

  it('verify-set keeps the checklist when --detail is omitted for the same sha', () => {
    seed({});
    runVerb('verify-set', ['abc', 'owed', '--detail', 'pod healthy'], ctx);
    runVerb('verify-set', ['abc', 'verifying'], ctx);
    expect(cache.load().verify?.detail).toBe('pod healthy');
    runVerb('verify-set', ['abc', 'red', '--detail', 'new list'], ctx);
    expect(cache.load().verify?.detail).toBe('new list');
  });

  it('verify-set drops a stale detail on a NEW sha', () => {
    seed({});
    runVerb('verify-set', ['abc', 'owed', '--detail', 'pod healthy'], ctx);
    runVerb('verify-set', ['def', 'owed'], ctx);
    expect(cache.load().verify?.detail).toBe('');
  });

  it('verify-get resets a verifying entry whose agent died (>20 min)', () => {
    const d = freshCache();
    d.verify = { sha: 'abc', status: 'verifying', detail: '', since: 1_000_000 - 1300 };
    cache.save(d);
    runVerb('verify-get', [], ctx);
    expect(cache.load().verify?.status).toBe('owed');
  });

  it('mirrors the verify state onto the release PR with THIS repo box-verify labels', () => {
    expect(verifyLabels('owed')).toEqual({ add: [L_VERIFY_PENDING], remove: [L_VERIFY_FAILED] });
    expect(verifyLabels('red')).toEqual({ add: [L_VERIFY_FAILED], remove: [L_VERIFY_PENDING] });
    expect(verifyLabels('green')).toEqual({ add: [], remove: [L_VERIFY_PENDING, L_VERIFY_FAILED] });
  });

  it('plan labels member issues autoloop:queued and next serves them in order', () => {
    seed({});
    runVerb('plan', ['{"id":"a1","kind":"issue","issues":[42],"gate":"normal"}'], ctx);
    expect(calls.some(a => a.includes('--add-label') && a.includes(L_QUEUED))).toBe(true);
    runVerb('next', [], ctx);
    expect(JSON.parse(out.at(-1)!).id).toBe('a1');
  });

  it('claim on an unknown unit is a setup error (2), not a silent win', () => {
    seed({});
    expect(runVerb('claim', ['nope'], ctx)).toBe(2);
  });

  it('summary stays compact — no unit bodies, no notes', () => {
    seed({ u1: { id: 'u1', issues: [1], status: 'planned', scope: 'x'.repeat(500) } });
    ctx.offline = true;
    runVerb('summary', [], ctx);
    const s = out.at(-1)!;
    expect(s).not.toContain('xxxxx');
    expect(JSON.parse(s)).toMatchObject({ planned_units: 1, next_unit: 'u1' });
    expect(s.length).toBeLessThan(400);
  });

  it('batchIssueCount ignores units the cache no longer holds', () => {
    const d = freshCache();
    d.units = { u1: { id: 'u1', issues: [1, 2] } };
    expect(batchIssueCount(d, { branch: 'b', count: 0, unit_ids: ['u1', 'gone'] })).toBe(2);
  });
});

describe('the retired work-queue.json stays retired', () => {
  const SKILLS = path.join(REPO_ROOT, '.claude', 'skills');

  const mdFiles = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return mdFiles(p);
      return e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.json')) ? [p] : [];
    });
  };

  it('has no work-queue template in the skill directory', () => {
    expect(existsSync(path.join(SKILLS, 'autoloop-issues', 'work-queue-template.json'))).toBe(false);
  });

  it('no committed skill doc still steers an agent at work-queue.json', () => {
    // A doc may NAME the file only to say it is retired ("never recreate it").
    // A doc that names it without that word is still describing it as live —
    // which is the exact defect #2639 is about.
    const offenders = mdFiles(SKILLS).filter(f => {
      const raw = readFileSync(f, 'utf8');
      return /work-queue/.test(raw) && !/retired/i.test(raw);
    });
    expect(offenders.map(f => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('the broker script is wired up as an npm verb', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['autoloop:queue']).toContain('scripts/autoloop-queue.ts');
  });

  it('the cache path is gitignored (losing it must be safe, committing it must be impossible)', () => {
    const r = spawnSync('git', ['check-ignore', '-q', '.claude/state/autoloop-cache.json'], { cwd: REPO_ROOT });
    expect(r.status).toBe(0);
  });
});
