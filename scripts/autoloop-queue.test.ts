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
 *
 * The stub also enforces GitHub's OTHER 422 — "Object does not exist" when the
 * ref's target is not an object the remote has (#2646). That is what made every
 * real claim fail: the target was local `HEAD`, i.e. the batch branch, which is
 * deliberately never pushed while building. So the fixture is a real git repo
 * with a real "remote", and its HEAD is deliberately unpushed.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  Cache,
  CACHE_DEFAULT,
  CACHE_VERSION,
  L_BUILDING,
  L_QUEUED,
  L_REFINE,
  L_REVIEW,
  L_VERIFY_FAILED,
  L_VERIFY_PENDING,
  NOTES_CAP,
  PARK_LABELS,
  REVIEW_WINDOW_DAYS,
  TEXT_MAX,
  acquireClaim,
  batchIssueCount,
  claimRef,
  clip,
  consolidationRefusal,
  freshCache,
  parkUnits,
  pruneState,
  resolveClaimSha,
  runVerb,
  splitReview,
  splitGlobalArgs,
  verifyLabels,
  type CacheState,
  type GhRunner,
  type Unit,
} from './autoloop-queue';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'autoloop-queue.ts');
/** Any 40-hex string: `acquireClaim` refuses a target that is not object-shaped. */
const REMOTE_SHA = 'a'.repeat(40);

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
    const r = acquireClaim([2639], gh, { sha: REMOTE_SHA });
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
    const r = acquireClaim([2639], gh, { sha: REMOTE_SHA });
    expect(r.ok).toBe(false);
    expect(r.lostOn).toBe(2639);
    // THE mutation guard: a lost claim must not reach the label, and must not
    // report a win. Flipping the `if (!res.ok)` guard turns this red.
    expect(calls.some(isLabelAdd)).toBe(false);
    expect(r.won).toEqual([]);
  });

  it('fails CLOSED on a transport error too (an unproven claim is not a claim)', () => {
    const { gh, calls } = fakeGh(a => (isRefCreate(a) ? { ok: false, out: 'dial tcp: i/o timeout' } : { ok: true, out: '' }));
    expect(acquireClaim([2639], gh, { sha: REMOTE_SHA }).ok).toBe(false);
    expect(calls.some(isLabelAdd)).toBe(false);
  });

  it('fails CLOSED with no usable target — no create is even attempted (#2646)', () => {
    // A ref we cannot point at an object the remote has can never be won, so
    // this must not grant a claim. Dropping the guard turns this red.
    const { gh, calls } = fakeGh();
    for (const sha of ['', 'HEAD', 'abc']) {
      const r = acquireClaim([2639], gh, { sha });
      expect(r.ok).toBe(false);
      expect(r.won).toEqual([]);
      expect(r.detail).toContain('no remote-known claim target');
    }
    expect(calls).toEqual([]);
  });

  it('claims a cluster all-or-nothing: a partial win is rolled back', () => {
    // Two instances racing a cluster: we win #10, lose #20.
    const { gh, calls } = fakeGh(a =>
      isRefCreate(a) && a.some(x => x.endsWith('/20'))
        ? { ok: false, out: 'Reference already exists (HTTP 422)' }
        : { ok: true, out: '' },
    );
    const r = acquireClaim([20, 10], gh, { sha: REMOTE_SHA });
    expect(r.ok).toBe(false);
    expect(r.won).toEqual([]);
    // #10 must be given back, or both instances deadlock holding half a cluster.
    expect(calls.filter(isRefDelete).some(a => a.some(x => x.endsWith('/10')))).toBe(true);
    expect(calls.some(isLabelAdd)).toBe(false);
  });

  it('claims in ascending issue order so racers collide on the same ref first', () => {
    const { gh, calls } = fakeGh();
    acquireClaim([30, 10, 20], gh, { sha: REMOTE_SHA });
    const created = calls.filter(isRefCreate).map(a => a.find(x => x.startsWith('ref='))!);
    expect(created).toEqual([`ref=${claimRef(10)}`, `ref=${claimRef(20)}`, `ref=${claimRef(30)}`]);
  });
});

describe('resolveClaimSha — a target the remote is guaranteed to have (#2646)', () => {
  it('prefers the origin/main tracking ref, and spends no API call doing it', () => {
    const { gh, calls } = fakeGh();
    expect(resolveClaimSha(gh, { git: () => REMOTE_SHA })).toBe(REMOTE_SHA);
    expect(calls).toEqual([]);
  });

  it('asks the API for the default-branch tip when the checkout has no origin/main', () => {
    const { gh, calls } = fakeGh(() => ({ ok: true, out: JSON.stringify({ object: { sha: REMOTE_SHA } }) }));
    expect(resolveClaimSha(gh, { repo: 'o/r', git: () => null })).toBe(REMOTE_SHA);
    expect(calls[0]).toEqual(['api', 'repos/o/r/git/ref/heads/main']);
  });

  it('yields nothing when neither resolves — the caller must then fail CLOSED', () => {
    const { gh } = fakeGh(() => ({ ok: false, out: 'dial tcp: i/o timeout' }));
    expect(resolveClaimSha(gh, { git: () => null })).toBe('');
  });

  it('refuses anything that is not object-shaped rather than passing it on', () => {
    // e.g. a `git rev-parse` that echoed the ref name back, or a truncated sha.
    const { gh } = fakeGh(() => ({ ok: true, out: JSON.stringify({ object: { sha: 'HEAD' } }) }));
    expect(resolveClaimSha(gh, { git: () => 'refs/remotes/origin/main' })).toBe('');
  });
});

/**
 * A REAL git checkout with a REAL remote, plus a `gh` stub that enforces BOTH of
 * GitHub's create-ref 422s: "Reference already exists" (the lock) and "Object
 * does not exist" (#2646 — the target must be something the remote already has).
 *
 * The work tree sits on a batch branch whose commit was deliberately never
 * pushed, which is exactly the state a builder claims from. `mkdir` is atomic
 * create-if-not-exists on POSIX, the same contract POST /git/refs offers.
 */
function claimFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'autoloop-claim-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const store = path.join(root, 'refs'); // the shared "GitHub" ref namespace
  const log = path.join(root, 'gh.log');
  const bin = path.join(root, 'bin');
  for (const d of [store, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(log, '');

  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'autoloop-test',
    GIT_AUTHOR_EMAIL: 'autoloop@test.invalid',
    GIT_COMMITTER_NAME: 'autoloop-test',
    GIT_COMMITTER_EMAIL: 'autoloop@test.invalid',
  };
  const git = (args: string[], cwd = work): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '--bare', '-b', 'main', remote], root);
  git(['init', '-b', 'main', work], root);
  git(['remote', 'add', 'origin', remote]);
  git(['commit', '--allow-empty', '-m', 'published']);
  git(['push', '-u', 'origin', 'main']);
  git(['checkout', '-b', 'batch/2026-01-01a']);
  git(['commit', '--allow-empty', '-m', 'batch work, NOT pushed']); // the builder's HEAD

  const ghStub = path.join(bin, 'gh');
  writeFileSync(
    ghStub,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(log)}`,
      'if [[ "$1" == "api" && "$*" == *"/git/ref/heads/main"* ]]; then',
      '  [[ -n "$GH_STUB_OFFLINE" ]] && { echo "dial tcp: i/o timeout" >&2; exit 1; }',
      `  printf '{"object":{"sha":"%s"}}' "$(git -C ${JSON.stringify(remote)} rev-parse main)"; exit 0`,
      'fi',
      'if [[ "$1" == "api" && "$*" == *"POST"* && "$*" == *"/git/refs"* ]]; then',
      '  for a in "$@"; do',
      '    [[ "$a" == ref=* ]] && REF="${a#ref=}"',
      '    [[ "$a" == sha=* ]] && SHA="${a#sha=}"',
      '  done',
      `  git -C ${JSON.stringify(remote)} cat-file -e "\${SHA}^{commit}" 2>/dev/null || {`,
      '    echo "Object does not exist (HTTP 422)" >&2; exit 1; }',
      `  mkdir ${JSON.stringify(store)}/"\${REF//\\//_}" 2>/dev/null || {`,
      '    echo "Reference already exists (HTTP 422)" >&2; exit 1; }',
      '  exit 0',
      'fi',
      'if [[ "$1" == "api" && "$*" == *"DELETE"* && "$*" == *"/git/refs/"* ]]; then',
      '  for a in "$@"; do [[ "$a" == repos/* ]] && P="$a"; done',
      '  REF="${P#*/git/}"',
      `  rmdir ${JSON.stringify(store)}/"\${REF//\\//_}" 2>/dev/null`,
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(ghStub, 0o755);

  /** Each instance gets its OWN cache — that is what a second loop instance is. */
  const seedCache = (name: string): string => {
    const p = path.join(root, `cache-${name}.json`);
    const d = freshCache();
    d.units.u1 = { id: 'u1', kind: 'issue', issues: [2639], status: 'planned' } satisfies Unit;
    new Cache(p).save(d);
    return p;
  };
  const run = (verb: string[], cachePath: string, env: Record<string, string> = {}) =>
    spawnSync(TSX, [SCRIPT, '--cache', cachePath, '--repo', 'mdopp/servicebay', ...verb], {
      cwd: work, // the builder's cwd: a batch branch, unpushed
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      timeout: 60_000,
    });

  return {
    root,
    store,
    seedCache,
    run,
    /** Move the remote's main on, as a merge on `main` does between two claims. */
    advanceOriginMain(): string {
      git(['checkout', 'main']);
      git(['commit', '--allow-empty', '-m', 'someone merged a PR']);
      git(['push', 'origin', 'main']);
      git(['checkout', 'batch/2026-01-01a']);
      return git(['rev-parse', 'refs/remotes/origin/main']);
    },
    originMain: (): string => git(['rev-parse', 'refs/remotes/origin/main']),
    head: (): string => git(['rev-parse', 'HEAD']),
    ghLog: (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    refCreates: (): string[] => readFileSync(log, 'utf8').split('\n').filter(l => l.includes('POST') && l.includes('/git/refs')),
  };
}

describe('claim — against a remote that validates the ref target (#2646)', () => {
  it('targets the published origin/main tip, NOT the unpushed batch HEAD', () => {
    // The reproduction: with local HEAD as the target this exits 3 with
    // "Object does not exist" — no claim is ever taken, so the only real
    // cross-instance lock in the pipeline is absent in the normal case.
    const f = claimFixture();
    const p = f.run(['claim', 'u1'], f.seedCache('solo'));
    expect(`${p.stdout}${p.stderr}`).not.toContain('Object does not exist');
    expect(p.status).toBe(0);
    expect(p.stdout).toContain('claimed u1');
    const create = f.refCreates();
    expect(create).toHaveLength(1);
    expect(create[0]).toContain(`sha=${f.originMain()}`);
    expect(create[0]).not.toContain(f.head());
    expect(readdirSync(f.store)).toEqual([claimRef(2639).replaceAll('/', '_')]);
  }, 90_000);

  it('round-trips: unclaim gives the ref back and the unit can be re-claimed', () => {
    const f = claimFixture();
    expect(f.run(['claim', 'u1'], f.seedCache('a')).status).toBe(0);
    expect(f.run(['unclaim', 'u1'], f.seedCache('a')).status).toBe(0);
    expect(readdirSync(f.store)).toEqual([]);
    const again = f.run(['claim', 'u1'], f.seedCache('b'));
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('claimed u1');
  }, 90_000);

  it('stays atomic on the ref NAME when origin/main moves between two claims', () => {
    // The target is free, so two claims may aim at DIFFERENT objects; the
    // create-if-not-exists is on the name, so the second one still loses.
    const f = claimFixture();
    expect(f.run(['claim', 'u1'], f.seedCache('first')).status).toBe(0);
    const moved = f.advanceOriginMain();
    const second = f.run(['claim', 'u1'], f.seedCache('second'));
    expect(second.status).toBe(3);
    expect(second.stdout).toContain('held by another loop instance');
    expect(second.stdout).toContain('Reference already exists');
    // …and it really did aim at the NEW tip — a different object, same name.
    expect(f.refCreates().at(-1)).toContain(`sha=${moved}`);
    expect(readdirSync(f.store)).toEqual([claimRef(2639).replaceAll('/', '_')]);
  }, 90_000);

  it('fails CLOSED when no remote-known target can be resolved', () => {
    // No origin tracking ref (a shallow/detached checkout) AND an API that is
    // unreachable => nothing to point the ref at. That must not grant a claim.
    const f = claimFixture();
    spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: path.join(f.root, 'work') });
    const p = f.run(['claim', 'u1'], f.seedCache('closed'), { GH_STUB_OFFLINE: '1' });
    expect(p.status).toBe(3);
    expect(p.stdout).toContain('no remote-known claim target');
    expect(f.refCreates()).toEqual([]); // never even attempted
    expect(f.ghLog().some(l => l.includes('--add-label') && l.includes(L_BUILDING))).toBe(false);
  }, 90_000);
});

describe('claim — six concurrent loop instances (the double-claim proof)', () => {
  const INSTANCES = 6;

  it('lets exactly ONE instance win, and only that one labels the issue', () => {
    const f = claimFixture();
    const caches = Array.from({ length: INSTANCES }, (_, i) => f.seedCache(String(i)));
    // Start them as close to simultaneously as possible, then collect.
    const procs = caches.map(cachePath => f.run(['claim', 'u1'], cachePath));

    const winners = procs.filter(p => p.status === 0);
    const losers = procs.filter(p => p.status === 3);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(INSTANCES - 1);
    expect(winners[0].stdout).toContain('claimed u1');
    for (const l of losers) expect(l.stdout).toContain('held by another loop instance');
    // Every instance aimed at an object the remote HAS — none was rejected for
    // the target (the #2646 failure would make all six lose, "winners" = 0).
    for (const p of procs) expect(`${p.stdout}${p.stderr}`).not.toContain('Object does not exist');

    // Exactly one ref exists, and the label was projected exactly once.
    expect(readdirSync(f.store)).toEqual([claimRef(2639).replaceAll('/', '_')]);
    expect(f.ghLog().filter(l => l.includes('--add-label') && l.includes(L_BUILDING))).toHaveLength(1);
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
    ctx = { cache, gh: f.gh, offline: false, sha: () => REMOTE_SHA, now: () => 1_000_000, out: s => out.push(s) };
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

  it('plan refuses an unknown kind rather than queueing a typo', () => {
    seed({});
    expect(runVerb('plan', ['{"id":"a1","kind":"consolidaton","issues":[]}'], ctx)).toBe(2);
    expect(cache.load().units.a1).toBeUndefined();
  });

  // #2746 — consolidation is what the loop does with a DRY queue, never instead
  // of the backlog, and it may take at most one slot per batch. Both rules are
  // enforced here rather than in the planner playbook's prose.
  it('plan takes a consolidation slot when no user issue waits, and shows it in summary', () => {
    seed({ ls: { id: 'ls', kind: 'lint-sweep', issues: [], status: 'planned' } });
    expect(runVerb('plan', ['{"id":"90-consolidate","kind":"consolidation","issues":[]}'], ctx)).toBe(0);
    ctx.offline = true;
    runVerb('summary', [], ctx);
    expect(JSON.parse(out.at(-1)!).consolidation_slot).toBe('90-consolidate');
  });

  it('plan refuses a consolidation slot while a user issue is still waiting', () => {
    seed({ u1: { id: 'u1', kind: 'issue', issues: [42], status: 'planned' } });
    expect(runVerb('plan', ['{"id":"90-consolidate","kind":"consolidation","issues":[]}'], ctx)).toBe(2);
    expect(cache.load().units['90-consolidate']).toBeUndefined();
    expect(out.at(-1)).toContain('user issues are waiting');
  });

  it('plan refuses a SECOND consolidation slot in the same batch', () => {
    seed({ c1: { id: 'c1', kind: 'consolidation', issues: [], status: 'built' } });
    expect(runVerb('plan', ['{"id":"c2","kind":"consolidation","issues":[]}'], ctx)).toBe(2);
    expect(out.at(-1)).toContain('at most one per batch');
  });

  it('consolidationRefusal clears once the batch resets', () => {
    const d = freshCache();
    d.units = { c1: { id: 'c1', kind: 'consolidation', issues: [], status: 'done' } };
    expect(consolidationRefusal(d)).toBeNull();
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

describe('CLI entry point — every verb is reachable however the globals are passed (#2644)', () => {
  // WHY this exists, and why it spawns: `runVerb` was thoroughly tested while
  // `main()` had NO coverage, so a CLI that printed usage for every real
  // invocation shipped through a fully green suite. The one test that did spawn
  // the script (the six-instance claim race) happened to pass BOTH --repo and
  // --cache — the single argv shape the broken index arithmetic survived.
  // So: drive it as a caller does (a real process), across the flag matrix.
  const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  const script = path.join(REPO_ROOT, 'scripts', 'autoloop-queue.ts');

  /** A cache holding one planned unit, so a reachable `next` has something to print. */
  const seededCache = (): string => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), 'autoloop-cli-')), 'cache.json');
    const d = freshCache();
    d.units.u1 = { id: 'u1', kind: 'issue', issues: [2644], status: 'planned' };
    new Cache(p).save(d);
    return p;
  };

  /** Run the script for real. `next` touches no network, so no `gh` stub is needed. */
  const run = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env, ...env };
    delete base.AUTOLOOP_REPO;
    return spawnSync(tsx, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: base, timeout: 60_000 });
  };

  const REPO = 'mdopp/servicebay';
  // Each flag combination is exercised in BOTH positions: an absent flag only
  // ate the verb when the verb sat at argv[0], so a matrix that always puts the
  // flags first would have passed straight through the bug.
  const cases: [name: string, args: (cache: string) => string[], env?: (cache: string) => Record<string, string>][] = [
    ['no flags at all', () => ['next'], cache => ({ AUTOLOOP_CACHE: cache })],
    ['--repo only, before the verb', () => ['--repo', REPO, 'next'], cache => ({ AUTOLOOP_CACHE: cache })],
    ['--repo only, after the verb', () => ['next', '--repo', REPO], cache => ({ AUTOLOOP_CACHE: cache })],
    ['--cache only, before the verb', cache => ['--cache', cache, 'next']],
    ['--cache only, after the verb', cache => ['next', '--cache', cache]],
    ['both flags, before the verb', cache => ['--repo', REPO, '--cache', cache, 'next']],
    ['both flags, after the verb', cache => ['next', '--cache', cache, '--repo', REPO]],
  ];

  for (const [name, args, env] of cases) {
    it(`reaches the verb with ${name}`, () => {
      const cache = seededCache();
      const p = run(args(cache), env?.(cache));
      // The regression's signature: usage text + exit 2 instead of running.
      expect(`${p.stdout}${p.stderr}`).not.toContain('usage: npm run autoloop:queue');
      expect(p.status).toBe(0);
      expect(JSON.parse(p.stdout)).toMatchObject({ id: 'u1', issues: [2644] });
    }, 60_000);
  }

  it('still prints usage when the verb really is missing', () => {
    const p = run([], { AUTOLOOP_CACHE: seededCache() });
    expect(p.stdout).toContain('usage: npm run autoloop:queue');
    expect(p.status).toBe(2);
  }, 60_000);
});

describe('splitGlobalArgs — the argv split main() uses', () => {
  const env = { AUTOLOOP_CACHE: '/env/cache.json', AUTOLOOP_REPO: 'env/repo' };

  it('keeps the verb when no global flag is present (the #2644 regression)', () => {
    // `indexOf('--repo')` is -1 when absent, and -1 + 1 === 0 dropped argv[0].
    expect(splitGlobalArgs(['rebuild'], {}).rest).toEqual(['rebuild']);
    expect(splitGlobalArgs(['park', '99', 'refinement', '--comment', 'A or B?'], {}).rest).toEqual([
      'park',
      '99',
      'refinement',
      '--comment',
      'A or B?',
    ]);
  });

  it('takes --repo alone, in either position, without eating the verb', () => {
    for (const argv of [
      ['--repo', 'mdopp/servicebay', 'rebuild'],
      ['rebuild', '--repo', 'mdopp/servicebay'], // the shape reported in #2644
    ]) {
      const g = splitGlobalArgs(argv, env);
      expect(g.rest).toEqual(['rebuild']);
      expect(g.repo).toBe('mdopp/servicebay');
      expect(g.cachePath).toBe('/env/cache.json'); // absent flag falls back to env
    }
  });

  it('takes --cache alone, in either position, without eating the verb', () => {
    for (const argv of [
      ['--cache', '/tmp/c.json', 'summary'],
      ['summary', '--cache', '/tmp/c.json'],
    ]) {
      const g = splitGlobalArgs(argv, env);
      expect(g.rest).toEqual(['summary']);
      expect(g.cachePath).toBe('/tmp/c.json');
      expect(g.repo).toBe('env/repo');
    }
  });

  it('takes both flags, in either position, and strips exactly them', () => {
    const before = splitGlobalArgs(['--repo', 'o/r', '--cache', '/c.json', 'claim', 'u1'], {});
    const after = splitGlobalArgs(['claim', 'u1', '--repo', 'o/r', '--cache', '/c.json'], {});
    for (const g of [before, after]) {
      expect(g.rest).toEqual(['claim', 'u1']);
      expect(g.repo).toBe('o/r');
      expect(g.cachePath).toBe('/c.json');
    }
  });

  it('handles --offline anywhere and defaults the cache path', () => {
    const g = splitGlobalArgs(['--offline', 'summary'], {});
    expect(g).toMatchObject({ offline: true, rest: ['summary'], cachePath: CACHE_DEFAULT, repo: undefined });
    expect(splitGlobalArgs(['summary', '--offline'], {}).rest).toEqual(['summary']);
    expect(splitGlobalArgs(['summary'], {}).offline).toBe(false);
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

/**
 * The worklist (#2690) — the list that could not see its own entries.
 *
 * An issue earns `autoloop:review` at the seal that SHIPS it, and the merged
 * PR's `Closes #…` closes it in the same breath, so every entry on that list is
 * closed. Both `summary` and the SKILL.md-suggested `gh issue list --label
 * autoloop:review` asked for OPEN issues only — live proof on this repo the day
 * it was filed: four entries (#2672 #2673 #2680 #2681), all closed, all
 * labelled, `"review": 0`. The counter-fix is not `--state all` everywhere:
 * `needs-refinement` shows what that decays into (eight closed leftovers of ten
 * hits). So the two lists are bounded differently, and both bounds are asserted
 * here.
 */
describe('worklist — the post-deploy review list must see closed issues (#2690)', () => {
  const NOW = 1_800_000_000;
  const iso = (daysAgo: number) => new Date((NOW - daysAgo * 86_400) * 1000).toISOString();

  /** The four real entries from the issue, plus a stale refinement tail. */
  const REVIEW_ROWS = [
    { number: 2681, title: 'claude-dev: device flow', state: 'CLOSED', closedAt: iso(0), updatedAt: iso(0) },
    { number: 2680, title: 'claude-dev: add/remove a project', state: 'CLOSED', closedAt: iso(0), updatedAt: iso(0) },
    { number: 2673, title: 'claude-dev: mint the MCP token', state: 'CLOSED', closedAt: iso(1), updatedAt: iso(1) },
    { number: 2672, title: 'claude-dev: world-readable gh token', state: 'CLOSED', closedAt: iso(2), updatedAt: iso(2) },
  ];
  const REFINE_ROWS = [
    { number: 2656, title: 'health: loopback', state: 'OPEN', closedAt: null, updatedAt: iso(4) },
    { number: 2591, title: 'backups have not run', state: 'OPEN', closedAt: null, updatedAt: iso(1) },
    { number: 1559, title: 'long closed', state: 'CLOSED', closedAt: iso(90), updatedAt: iso(90) },
    { number: 1233, title: 'long closed too', state: 'CLOSED', closedAt: iso(95), updatedAt: iso(95) },
  ];

  /** A `gh` that answers issue-list queries per label, and records every call. */
  const worklistGh = (rows: Record<string, unknown[]> = { [L_REVIEW]: REVIEW_ROWS, [L_REFINE]: REFINE_ROWS }) =>
    fakeGh(a => {
      if (a[0] !== 'issue' || a[1] !== 'list') return { ok: true, out: '' };
      const label = a[a.indexOf('--label') + 1]!;
      const state = a[a.indexOf('--state') + 1];
      const all = rows[label] ?? [];
      // Reproduce gh's own default faithfully: --state open hides the closed ones.
      const visible = state === 'all' ? all : all.filter(r => (r as { state: string }).state === 'OPEN');
      return { ok: true, out: JSON.stringify(visible) };
    });

  const mkCtx = (gh: GhRunner, out: string[]) => ({
    cache: new Cache(path.join(mkdtempSync(path.join(tmpdir(), 'autoloop-worklist-')), 'cache.json')),
    gh,
    offline: false,
    sha: () => REMOTE_SHA,
    now: () => NOW,
    out: (s: string) => out.push(s),
  });

  it('lists the four shipped-and-closed review entries the open-only query could not see', () => {
    const out: string[] = [];
    const { gh, calls } = worklistGh();
    expect(runVerb('worklist', [], mkCtx(gh, out))).toBe(0);
    const review = out.filter(l => l.startsWith('Review post-deploy:'));
    expect(review).toHaveLength(4);
    for (const n of [2672, 2673, 2680, 2681]) expect(review.join('\n')).toContain(`#${n}`);
    // Structural: the review query must ask GitHub for closed issues too.
    const q = calls.find(a => a.includes('--label') && a.includes(L_REVIEW))!;
    expect(q.slice(q.indexOf('--state'), q.indexOf('--state') + 2)).toEqual(['--state', 'all']);
  });

  it('summary counts what worklist lists — the count cannot become a second thing that lies', () => {
    const out: string[] = [];
    const ctx = mkCtx(worklistGh().gh, out);
    runVerb('summary', [], ctx);
    const gh = JSON.parse(out.at(-1)!).gh;
    expect(gh).toMatchObject({ review: 4, review_aged: 0, needs_refinement: 2, needs_refinement_stale: 2 });
    out.length = 0;
    runVerb('worklist', [], ctx);
    expect(out.filter(l => l.startsWith('Review post-deploy: #'))).toHaveLength(gh.review);
    expect(out.filter(l => l.startsWith('Needs refinement:   #'))).toHaveLength(gh.needs_refinement);
  });

  it('bounds the review list by recency — aged entries are reported as a count, never dropped', () => {
    const items = [
      { number: 1, title: 'shipped today', state: 'CLOSED', at: NOW },
      { number: 2, title: 'just inside the window', state: 'CLOSED', at: NOW - (REVIEW_WINDOW_DAYS - 1) * 86_400 },
      { number: 3, title: 'aged out', state: 'CLOSED', at: NOW - (REVIEW_WINDOW_DAYS + 1) * 86_400 },
      { number: 4, title: 'ancient but still open', state: 'OPEN', at: NOW - 400 * 86_400 },
    ];
    const s = splitReview(items, NOW);
    expect(s.due.map(i => i.number)).toEqual([1, 2, 4]);
    expect(s.aged.map(i => i.number)).toEqual([3]);

    const out: string[] = [];
    const aged = [{ number: 9, title: 'shipped in June', state: 'CLOSED', closedAt: iso(90), updatedAt: iso(90) }];
    runVerb('worklist', [], mkCtx(worklistGh({ [L_REVIEW]: aged, [L_REFINE]: [] }).gh, out));
    expect(out.join('\n')).toContain('+1 older than');
    expect(out.join('\n')).toContain('#9'); // named, not silently swallowed
  });

  it('--prune clears the refinement label off closed leftovers only', () => {
    const out: string[] = [];
    const { gh, calls } = worklistGh();
    runVerb('worklist', ['--prune'], mkCtx(gh, out));
    const cleared = calls
      .filter(a => a.includes('--remove-label') && a.includes(L_REFINE))
      .map(a => Number(a[a.indexOf('edit') + 1]));
    expect(cleared.sort()).toEqual([1233, 1559]); // the closed ones, and nothing else
    expect(calls.some(a => a.includes('--remove-label') && a.includes(L_REVIEW))).toBe(false);
  });

  it('reports what gh actually did — a refused label removal is never announced as cleared', () => {
    const out: string[] = [];
    // The house failure form: success reported, nothing done. Half the removals fail.
    const base = worklistGh().gh;
    const gh: GhRunner = a =>
      a.includes('--remove-label') && a.includes('1233') ? { ok: false, out: 'HTTP 403' } : base(a);
    runVerb('worklist', ['--prune'], mkCtx(gh, out));
    const text = out.join('\n');
    expect(text).toContain('cleared 1 closed leftovers (#1559)');
    expect(text).toContain('FAILED to clear 1 (#1233)');
  });

  it('reviewed <issue> retires an eyeballed entry; a missing argument is a setup error', () => {
    const out: string[] = [];
    const { gh, calls } = worklistGh();
    expect(runVerb('reviewed', ['2672'], mkCtx(gh, out))).toBe(0);
    expect(calls.some(a => a.includes('2672') && a.includes('--remove-label') && a.includes(L_REVIEW))).toBe(true);
    expect(runVerb('reviewed', [], mkCtx(gh, out))).toBe(2);
    const refusing: GhRunner = () => ({ ok: false, out: 'HTTP 403' });
    expect(runVerb('reviewed', ['2672'], mkCtx(refusing, out))).toBe(1); // never a silent success
  });
});
