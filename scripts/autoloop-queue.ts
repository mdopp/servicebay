/**
 * Autoloop STATE BROKER as a deterministic script (#2639).
 *
 * Retires `.claude/state/work-queue.json` — one fat JSON blob every stage re-read
 * in full each tick (~82 KB / ~13k tokens in the sibling repo before it was
 * dropped) and mutated as free JSON. That shape had two real defects:
 *   1. token cost — every stage paid for the whole file to read one field;
 *   2. it was NOT safe under two loop instances, because the "who owns this
 *      issue" claim lived in a *local* file. Two loops could claim one issue.
 *
 * This broker splits state by durability, porting the design already proven in
 * `mdopp/solarisbay` (`.claude/skills/autoloop-issues/queue.py`):
 *
 *   * DURABLE / core state -> GitHub (the source of truth): issue open/closed,
 *     work status as `autoloop:*` labels, human questions as issue comments,
 *     completion as closed-issue + merged-PR. Survives crashes, machines and
 *     concurrent loop instances.
 *   * EPHEMERAL run state -> a tiny cache (`.claude/state/autoloop-cache.json`,
 *     gitignored via the existing `/.claude/*` rule): the in-flight batch, this
 *     run's unit plan, the verify state-machine, a bounded notes ring. It is
 *     rebuildable from GitHub (`rebuild`), so losing it is safe and it is never
 *     the source of truth.
 *
 * Stages call narrow verbs and get back only the slice they need, so no stage
 * ever loads the whole state into context. Caps, pruning and label projection
 * are enforced HERE, in code — not in prose a model must remember each run
 * (CLAUDE.md: "Deterministic execution -> scripts; LLMs coordinate + evaluate").
 *
 * House pattern: tsx, `node:` only, no new dependency (sibling to
 * scripts/autoloop-seal.ts). The sibling repo's broker is Python; this repo's
 * binding house rule is `tsx scripts/*.ts`, so the *design* is ported and the
 * host language follows the house — see docs in SKILL.md § state.
 *
 *   npm run autoloop:queue -- <verb> [args]      (tsx scripts/autoloop-queue.ts)
 *
 * ── THE CLAIM (the load-bearing part) ────────────────────────────────────────
 * A claim must make a double-claim by two loop instances IMPOSSIBLE, not merely
 * unlikely. `gh issue edit --add-label` cannot do that: adding a label that is
 * already present succeeds, so two instances both "win". So the claim is taken
 * with the one primitive GitHub gives that is a genuine atomic
 * create-if-not-exists: `POST /repos/{owner}/{repo}/git/refs`, which returns
 * HTTP 422 "Reference already exists" when the ref is already there (verified
 * live against this repo, 2026-08-25). The ref is `refs/autoloop/claim/<issue>`.
 * The human-visible `autoloop:building` label is the PROJECTION of that claim —
 * applied only after the ref is won, never the thing that grants it. Any
 * non-success from the ref create (conflict *or* transport error) counts as
 * "not won": a claim you cannot prove you hold is not yours (fail closed).
 *
 * WHAT THE REF POINTS AT (#2646). Creating a ref needs a target object, and the
 * remote must already HAVE that object — otherwise the create fails 422 "Object
 * does not exist" and no claim is ever taken. The original target was local
 * `HEAD`, which is the batch branch: deliberately never pushed while building,
 * so the remote has never seen it and EVERY claim failed in the normal case —
 * the double-claim guarantee was absent exactly when it was needed. The ref
 * carries no information beyond its existence, so the target is free; we use
 * `origin/main`'s tip, which the remote is guaranteed to know (a remote-tracking
 * ref only ever points at something origin published). If `origin/main` MOVES
 * between two racing claims they simply create the same ref NAME at two
 * different targets — the atomicity is on the name, so the loser still gets 422
 * "Reference already exists" (both shapes verified live, 2026-08-25).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

export const CACHE_DEFAULT = '.claude/state/autoloop-cache.json';
export const CACHE_VERSION = 1;
export const NOTES_CAP = 15; // run-scoped scratch ring; durable history is git + issues
export const TEXT_MAX = 2000; // free-text bound (note / verify detail)
export const LOCK_STALE_S = 600; // a lock older than this is abandoned

const L = 'autoloop:';
export const L_QUEUED = `${L}queued`;
export const L_BUILDING = `${L}building`;
export const L_BLOCKED = `${L}blocked`;
export const L_REFINE = `${L}needs-refinement`;
export const L_REVIEW = `${L}review`;
export const L_DEVICE = `${L}device-test`;
export const L_UPSTREAM = `${L}upstream-wait`;
export const L_AWAITING = `${L}awaiting-user`;
export const L_VERIFY_PENDING = `${L}box-verify-pending`;
export const L_VERIFY_FAILED = `${L}box-verify-failed`;

/** Durable per-issue states, each projected as exactly one `autoloop:*` label. */
export const PARK_LABELS: Readonly<Record<string, string>> = {
  blocked: L_BLOCKED,
  refinement: L_REFINE,
  review: L_REVIEW,
  'device-test': L_DEVICE,
  'upstream-wait': L_UPSTREAM,
  'awaiting-user': L_AWAITING,
};

/** Every label this broker owns — used by the claim-hygiene assertions. */
export const CLAIM_REF_PREFIX = 'refs/autoloop/claim';
export const claimRef = (issue: number | string): string => `${CLAIM_REF_PREFIX}/${issue}`;

// --------------------------------------------------------------------- gh shim

export interface GhResult {
  ok: boolean;
  out: string;
}
/** Injectable `gh` runner so the claim protocol is testable without GitHub. */
export type GhRunner = (args: string[]) => GhResult;

export const realGh: GhRunner = args => {
  try {
    return {
      ok: true,
      out: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
};

const OFFLINE_GH: GhRunner = () => ({ ok: false, out: 'offline' });

/** Injectable `git` runner (null = the command failed / the ref is absent). */
export type GitRunner = (args: string[]) => string | null;

export const realGit: GitRunner = args => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const isSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

function ghJson<T>(gh: GhRunner, args: string[], fallback: T): T {
  const r = gh(args);
  if (!r.ok || !r.out.trim()) return fallback;
  try {
    return JSON.parse(r.out) as T;
  } catch {
    return fallback;
  }
}

const repoArgs = (repo?: string): string[] => (repo ? ['-R', repo] : []);
/** `gh api` resolves `{owner}/{repo}` from the checkout; an explicit --repo wins. */
const apiRepo = (repo?: string): string => repo ?? '{owner}/{repo}';

// ----------------------------------------------------------------------- cache

export interface Unit {
  id: string;
  kind?: string;
  issues?: number[];
  theme?: string;
  region?: string;
  scope?: string;
  acceptance?: string;
  gate?: string;
  security?: boolean;
  status?: string;
  pr?: number | null;
  notes?: string;
}
export interface Batch {
  branch: string;
  count: number;
  unit_ids: string[];
  sealed?: boolean;
}
export interface VerifyState {
  sha: string;
  status: string;
  detail: string;
  since: number;
}
export interface CacheState {
  version: number;
  batch: Batch | null;
  units: Record<string, Unit>;
  verify: VerifyState | null;
  notes: { note: string; since: number }[];
  lock: { pid: number; since: number } | null;
  last_codebase_eval: number | null;
  last_invocation: number | null;
}

export function freshCache(): CacheState {
  return {
    version: CACHE_VERSION,
    batch: null,
    units: {},
    verify: null,
    notes: [],
    lock: null,
    last_codebase_eval: null,
    last_invocation: null,
  };
}

/** Bound free text, never silently — a clipped checklist must read as clipped. */
export function clip(text: string, limit = TEXT_MAX): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [clipped, ${text.length - limit} chars dropped]`;
}

/** Enforce the caps in code so the cache can never grow unbounded. */
export function pruneState(d: CacheState): CacheState {
  if (d.notes.length > NOTES_CAP) d.notes = d.notes.slice(-NOTES_CAP);
  // Drop finished units — GitHub (closed issues / merged PRs) is the durable record.
  d.units = Object.fromEntries(Object.entries(d.units).filter(([, u]) => u.status !== 'done'));
  return d;
}

export class Cache {
  constructor(readonly path: string) {}

  load(): CacheState {
    if (!existsSync(this.path)) return freshCache();
    try {
      return { ...freshCache(), ...(JSON.parse(readFileSync(this.path, 'utf8')) as CacheState) };
    } catch {
      return freshCache();
    }
  }

  save(d: CacheState): void {
    const pruned = pruneState(d);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(pruned, null, 2)}\n`);
    renameSync(tmp, this.path); // atomic on POSIX
  }
}

// ----------------------------------------------------------------------- claim

export interface ClaimOutcome {
  ok: boolean;
  won: number[];
  lostOn?: number;
  detail?: string;
}

/**
 * A claim-ref target the REMOTE is guaranteed to already have (#2646).
 *
 * `origin/main`'s tip: a remote-tracking ref only ever names a commit origin
 * published, so the create can't 422 "Object does not exist" — unlike local
 * `HEAD`, which on a mid-build batch branch is by design unpushed. A *stale*
 * `origin/main` is still fine (an older tip is still an object the remote has),
 * so this needs no fetch. `git` first because it costs no API call; the `gh`
 * fallback covers a checkout without the tracking ref (shallow / detached CI).
 * Returns `''` when neither resolves — the caller must then fail CLOSED.
 */
export function resolveClaimSha(gh: GhRunner, opts: { repo?: string; git?: GitRunner } = {}): string {
  const git = opts.git ?? realGit;
  const tracked = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (isSha(tracked)) return tracked;
  const r = ghJson<{ object?: { sha?: string } }>(gh, ['api', `repos/${apiRepo(opts.repo)}/git/ref/heads/main`], {});
  return isSha(r.object?.sha) ? r.object.sha : '';
}

/**
 * Atomically claim every issue of a unit, or none of them.
 *
 * The ONLY thing that grants a claim is a successful `POST git/refs` — GitHub's
 * create-if-not-exists (422 "Reference already exists" on conflict). Issues are
 * claimed in ascending order so two instances racing a shared issue collide on
 * the same ref first; a partial win is rolled back so neither instance can
 * deadlock holding half a cluster. The `autoloop:building` label is applied
 * only after every ref is won — it is a projection, never the lock.
 */
export function acquireClaim(
  issues: (number | string)[],
  gh: GhRunner,
  opts: { repo?: string; sha: string },
): ClaimOutcome {
  // No usable target => no create is even attempted. A ref we cannot point at
  // an object the remote has can never be won, so this must NOT grant a claim.
  if (!isSha(opts.sha)) {
    return { ok: false, won: [], detail: `no remote-known claim target (got ${JSON.stringify(opts.sha)})` };
  }
  const ordered = [...issues].map(Number).sort((a, b) => a - b);
  const won: number[] = [];
  for (const issue of ordered) {
    const res = gh([
      'api',
      '--method',
      'POST',
      `repos/${apiRepo(opts.repo)}/git/refs`,
      '-f',
      `ref=${claimRef(issue)}`,
      '-f',
      `sha=${opts.sha}`,
    ]);
    // Fail CLOSED: conflict *or* transport error both mean "not proven mine".
    if (!res.ok) {
      releaseClaim(won, gh, { repo: opts.repo, label: false });
      return { ok: false, won: [], lostOn: issue, detail: res.out.slice(0, 300) };
    }
    won.push(issue);
  }
  // Projection only — this runs after the lock is already held.
  for (const issue of won) {
    gh([
      ...repoArgs(opts.repo),
      'issue',
      'edit',
      String(issue),
      '--add-label',
      L_BUILDING,
      '--remove-label',
      L_QUEUED,
    ]);
  }
  return { ok: true, won };
}

/** Drop the claim: delete the ref (the lock) and, by default, its label projection. */
export function releaseClaim(
  issues: (number | string)[],
  gh: GhRunner,
  opts: { repo?: string; label?: boolean } = {},
): void {
  for (const issue of issues) {
    gh(['api', '--method', 'DELETE', `repos/${apiRepo(opts.repo)}/git/${claimRef(issue)}`]);
    if (opts.label !== false) {
      gh([...repoArgs(opts.repo), 'issue', 'edit', String(issue), '--remove-label', L_BUILDING]);
    }
  }
}

export function verifyLabels(status: string): { add: string[]; remove: string[] } {
  if (status === 'owed' || status === 'verifying') {
    return { add: [L_VERIFY_PENDING], remove: [L_VERIFY_FAILED] };
  }
  if (status === 'red') return { add: [L_VERIFY_FAILED], remove: [L_VERIFY_PENDING] };
  return { add: [], remove: [L_VERIFY_PENDING, L_VERIFY_FAILED] }; // green / clear
}

function mirrorVerifyLabel(gh: GhRunner, repo: string | undefined, pr: number, status: string): void {
  const { add, remove } = verifyLabels(status);
  for (const l of remove) gh([...repoArgs(repo), 'pr', 'edit', String(pr), '--remove-label', l]);
  for (const l of add) gh([...repoArgs(repo), 'pr', 'edit', String(pr), '--add-label', l]);
}

/** Take every not-yet-built unit containing this issue out of `next`'s rotation. */
export function parkUnits(d: CacheState, issue: number): string[] {
  const parked: string[] = [];
  for (const [uid, u] of Object.entries(d.units)) {
    if (!(u.issues ?? []).map(String).includes(String(issue))) continue;
    if (u.status === 'planned' || u.status === 'building') {
      u.status = 'parked';
      parked.push(uid);
    }
  }
  return parked;
}

/** Batch economy counts ISSUES (8), not units — a cluster carries several. */
export function batchIssueCount(d: CacheState, b: Batch): number {
  return b.unit_ids.reduce((n, uid) => n + (d.units[uid]?.issues?.length ?? 0), 0);
}

// ----------------------------------------------------------------------- verbs

export interface Ctx {
  cache: Cache;
  gh: GhRunner;
  repo?: string;
  offline: boolean;
  /** The claim ref's target — must be an object the REMOTE has (see #2646). */
  sha: () => string;
  out: (s: string) => void;
  now: () => number;
}

const countLabel = (c: Ctx, label: string): number =>
  ghJson<unknown[]>(
    c.gh,
    [...repoArgs(c.repo), 'issue', 'list', '--state', 'open', '--label', label, '--json', 'number', '--limit', '200'],
    [],
  ).length;

// ------------------------------------------------------------------- worklist

/**
 * How long a shipped, security-flagged issue stays on the post-deploy eyeball
 * list (#2690).
 *
 * `autoloop:review` is earned at the seal — and the merged PR's `Closes #…`
 * closes the issue in the same breath. **The state an entry must be in to
 * belong on that list is CLOSED**, so an open-only query (what `summary` and
 * SKILL.md both used to ask) can structurally never see one: four real entries,
 * `"review": 0`.
 *
 * Asking `--state all` instead is only half a fix. `autoloop:needs-refinement`
 * shows what an unbounded state-agnostic list decays into: ten hits, eight of
 * them closed leftovers from months ago that nobody will clear — a list ignored
 * exactly like the empty one. So each list gets the bound its own semantics
 * imply:
 *   - `review`: closed is the CORRECT state, so the query is state-agnostic and
 *     the bound is RECENCY, which is what "post-deploy" means. Older entries are
 *     never silently dropped — they are reported as one aged count and retired
 *     deliberately with `reviewed <issue>`.
 *   - `needs-refinement`: closed is a WRONG state (a closed issue needs no
 *     refinement), so those are stale labels, reported apart from the worklist
 *     and cleared by `worklist --prune` instead of padding it.
 */
export const REVIEW_WINDOW_DAYS = 14;
const DAY_S = 86_400;

export interface WorklistItem {
  number: number;
  title: string;
  state: string;
  /** When the entry became relevant: `closedAt` when closed, else `updatedAt`. */
  at: number;
}
export interface Worklist {
  /** Shipped security work: `due` = eyeball now, `aged` = past the window, still labelled. */
  review: { due: WorklistItem[]; aged: WorklistItem[] };
  /** The human's worklist: `open` = real entries, `stale` = closed leftovers to clear. */
  refinement: { open: WorklistItem[]; stale: WorklistItem[] };
}

interface IssueRow {
  number: number;
  title?: string;
  state?: string;
  closedAt?: string | null;
  updatedAt?: string | null;
}

/** Every issue carrying `label`, OPEN **or** CLOSED, newest first. */
function labelled(c: Ctx, label: string): WorklistItem[] {
  return ghJson<IssueRow[]>(
    c.gh,
    [
      ...repoArgs(c.repo),
      'issue',
      'list',
      '--state',
      'all',
      '--label',
      label,
      '--json',
      'number,title,state,closedAt,updatedAt',
      '--limit',
      '200',
    ],
    [],
  )
    .map(r => ({
      number: r.number,
      title: r.title ?? '',
      state: (r.state ?? '').toUpperCase(),
      at: Math.floor(Date.parse(r.closedAt || r.updatedAt || '') / 1000) || 0,
    }))
    .sort((a, b) => b.at - a.at);
}

/** Split the review list into what is due for an eyeball and what has aged out. */
export function splitReview(
  items: WorklistItem[],
  now: number,
  windowDays = REVIEW_WINDOW_DAYS,
): Worklist['review'] {
  const cutoff = now - windowDays * DAY_S;
  // An OPEN review entry is shipped-but-not-closed: always due, whatever its age.
  const isDue = (i: WorklistItem) => i.state === 'OPEN' || i.at >= cutoff;
  return { due: items.filter(isDue), aged: items.filter(i => !isDue(i)) };
}

/** The one source both the `summary` counts and the `worklist` listing read. */
export function collectWorklist(c: Ctx): Worklist {
  const refine = labelled(c, L_REFINE);
  return {
    review: splitReview(labelled(c, L_REVIEW), c.now()),
    refinement: {
      open: refine.filter(i => i.state === 'OPEN'),
      stale: refine.filter(i => i.state !== 'OPEN'),
    },
  };
}

const nums = (ns: number[]): string => ns.map(n => `#${n}`).join(' ');
const short = (s: string): string => (s.length > 72 ? `${s.slice(0, 71)}…` : s);
const day = (t: number): string => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '?');

export const VERBS: Record<string, (c: Ctx, a: Args) => number> = {
  /** Compact status for the orchestrator's preflight — never the whole state. */
  summary(c) {
    const d = c.cache.load();
    const planned = Object.values(d.units).filter(u => u.status === 'planned');
    // The counts come from the SAME worklist the `worklist` verb prints, so a
    // count and its listing cannot disagree (#2690).
    const w = c.offline ? null : collectWorklist(c);
    c.out(
      JSON.stringify(
        {
          batch: d.batch ? { branch: d.batch.branch, count: d.batch.count } : null,
          verify: d.verify ? { sha: d.verify.sha, status: d.verify.status } : null,
          planned_units: planned.length,
          next_unit: planned[0]?.id ?? null,
          last_codebase_eval: d.last_codebase_eval,
          gh: w
            ? {
                queued: countLabel(c, L_QUEUED),
                building: countLabel(c, L_BUILDING),
                blocked: countLabel(c, L_BLOCKED),
                needs_refinement: w.refinement.open.length,
                needs_refinement_stale: w.refinement.stale.length,
                review: w.review.due.length,
                review_aged: w.review.aged.length,
                awaiting_user: countLabel(c, L_AWAITING),
              }
            : {},
        },
        null,
        2,
      ),
    );
    return 0;
  },

  /**
   * The human-facing lists behind the end-of-firing summary (#2690) — printed
   * from the same `collectWorklist` the `summary` counts use, so the count and
   * the listing can never disagree. `--prune` clears the stale closed
   * `needs-refinement` labels it reports (the planner's label hygiene).
   */
  worklist(c, a) {
    const w = collectWorklist(c);
    for (const i of w.review.due) {
      c.out(`Review post-deploy: #${i.number} ${short(i.title)} (shipped ${day(i.at)})`);
    }
    if (w.review.aged.length) {
      c.out(
        `Review post-deploy: +${w.review.aged.length} older than ${REVIEW_WINDOW_DAYS}d, still labelled ` +
          `(${nums(w.review.aged.map(i => i.number))}) — retire with \`queue -- reviewed <issue>\``,
      );
    }
    for (const i of w.refinement.open) c.out(`Needs refinement:   #${i.number} ${short(i.title)}`);
    if (w.refinement.stale.length && a.prune) {
      // Report what `gh` ACTUALLY did, never the intent: a sweep that announces
      // success it did not achieve is the same defect one level down (#2690).
      const cleared: number[] = [];
      const failed: number[] = [];
      for (const i of w.refinement.stale) {
        const r = c.gh([...repoArgs(c.repo), 'issue', 'edit', String(i.number), '--remove-label', L_REFINE]);
        (r.ok ? cleared : failed).push(i.number);
      }
      if (cleared.length) c.out(`Needs refinement:   cleared ${cleared.length} closed leftovers (${nums(cleared)})`);
      if (failed.length) {
        c.out(`Needs refinement:   FAILED to clear ${failed.length} (${nums(failed)}) — retry, or clear by hand`);
      }
    } else if (w.refinement.stale.length) {
      c.out(
        `Needs refinement:   ${w.refinement.stale.length} closed leftovers still labelled ` +
          `(${nums(w.refinement.stale.map(i => i.number))}) — clear with \`queue -- worklist --prune\``,
      );
    }
    if (!w.review.due.length && !w.review.aged.length && !w.refinement.open.length && !w.refinement.stale.length) {
      c.out('worklist empty');
    }
    return 0;
  },

  /** Retire a post-deploy review entry once a human has actually eyeballed it. */
  reviewed(c, a) {
    const issue = Number(a._[0]);
    if (!Number.isInteger(issue) || issue <= 0) {
      c.out('usage: reviewed <issue>');
      return 2;
    }
    const r = c.gh([...repoArgs(c.repo), 'issue', 'edit', String(issue), '--remove-label', L_REVIEW]);
    if (!r.ok) {
      c.out(`#${issue}: could not clear ${L_REVIEW} (${clip(r.out)})`);
      return 1;
    }
    c.out(`#${issue} eyeballed -> ${L_REVIEW} cleared`);
    return 0;
  },

  /** Open, selectable issues in priority order — for the planner. */
  candidates(c, a) {
    const exclude = new Set(String(a.exclude ?? 'postponed,wontfix,duplicate,autoloop-open').split(',').filter(Boolean));
    const order = String(a.order ?? '').split(',').filter(Boolean);
    const claimed = new Set([L_QUEUED, L_BUILDING, L_BLOCKED, L_REFINE, L_REVIEW, L_DEVICE, L_UPSTREAM, L_AWAITING]);
    const issues = ghJson<{ number: number; title: string; labels: { name: string }[] }[]>(
      c.gh,
      [...repoArgs(c.repo), 'issue', 'list', '--state', 'open', '--json', 'number,title,labels', '--limit', '300'],
      [],
    );
    const picked = issues
      .map(it => ({ it, labels: new Set(it.labels.map(l => l.name)) }))
      .filter(({ labels }) => ![...labels].some(l => exclude.has(l) || claimed.has(l)))
      .map(({ it, labels }) => {
        const rank = order.findIndex(o => labels.has(o));
        return { rank: rank < 0 ? order.length : rank, number: it.number, title: it.title };
      })
      .sort((x, y) => x.rank - y.rank || x.number - y.number);
    c.out(JSON.stringify(picked.map(({ number, title }) => ({ number, title })), null, 2));
    return 0;
  },

  /** Record a planned unit + label its member issues `autoloop:queued`. */
  plan(c, a) {
    const unit = JSON.parse(String(a._[0])) as Unit;
    unit.status ??= 'planned';
    unit.pr ??= null;
    const d = c.cache.load();
    d.units[String(unit.id)] = unit;
    c.cache.save(d);
    for (const n of unit.issues ?? []) {
      c.gh([...repoArgs(c.repo), 'issue', 'edit', String(n), '--add-label', L_QUEUED]);
    }
    c.out(`planned unit ${unit.id}: issues ${JSON.stringify(unit.issues ?? [])}`);
    return 0;
  },

  /** The next planned unit the builder should implement (or `null`). */
  next(c) {
    const d = c.cache.load();
    const planned = Object.values(d.units)
      .filter(u => u.status === 'planned')
      .sort((x, y) => String(x.id).localeCompare(String(y.id)));
    c.out(JSON.stringify(planned[0] ?? null, null, 2));
    return 0;
  },

  /** Cross-instance claim. Exit 3 = another instance holds it — do NOT build. */
  claim(c, a) {
    const d = c.cache.load();
    const u = d.units[String(a._[0])];
    if (!u) {
      c.out(`no planned unit ${a._[0]}`);
      return 2;
    }
    const outcome = acquireClaim(u.issues ?? [], c.gh, { repo: c.repo, sha: c.sha() });
    if (!outcome.ok) {
      // Exit 3 is "you do NOT hold this unit, do not build" — a rival claim and
      // an unprovable one are the same instruction to the builder (fail closed).
      const why = outcome.lostOn
        ? `#${outcome.lostOn} is held by another loop instance`
        : 'the claim could not be taken';
      c.out(`NOT claimed ${u.id}: ${why} (${outcome.detail ?? ''})`);
      return 3;
    }
    u.status = 'building';
    c.cache.save(d);
    c.out(`claimed ${u.id} (${JSON.stringify(outcome.won)})`);
    return 0;
  },

  /** Release a claim (bounce to refinement, abandoned build, operator recovery). */
  unclaim(c, a) {
    const d = c.cache.load();
    const u = d.units[String(a._[0])];
    const issues = u?.issues ?? [Number(a._[0])].filter(n => Number.isFinite(n) && n > 0);
    releaseClaim(issues, c.gh, { repo: c.repo });
    if (u && u.status === 'building') u.status = 'planned';
    c.cache.save(d);
    c.out(`unclaimed ${JSON.stringify(issues)}`);
    return 0;
  },

  /** Outstanding claims — which issues some instance currently holds. */
  claims(c) {
    const refs = ghJson<{ ref: string }[]>(
      c.gh,
      ['api', `repos/${apiRepo(c.repo)}/git/matching-refs/autoloop/claim`],
      [],
    );
    c.out(JSON.stringify(refs.map(r => Number(r.ref.split('/').pop())), null, 2));
    return 0;
  },

  /** Mark a unit built onto the batch (PR attached at seal). */
  built(c, a) {
    const d = c.cache.load();
    const u = d.units[String(a._[0])];
    if (!u) {
      c.out(`no unit ${a._[0]}`);
      return 2;
    }
    u.status = 'built';
    if (a.pr) u.pr = Number(a.pr);
    // NOTE (divergence from the sibling repo, deliberate): in ServiceBay a
    // `security:true` unit rides the SHARED batch like any other and is flagged
    // for POST-deploy review (SKILL.md); it is not a draft on its own branch.
    // So it is counted here.
    if (d.batch && !d.batch.unit_ids.includes(String(u.id))) {
      d.batch.unit_ids.push(String(u.id));
      d.batch.count = batchIssueCount(d, d.batch);
    }
    c.cache.save(d);
    c.out(`built ${u.id}; batch count ${d.batch?.count ?? 0}`);
    return 0;
  },

  batch(c, a) {
    const d = c.cache.load();
    const action = String(a._[0] ?? '');
    if (action === 'new') d.batch = { branch: String(a.branch ?? ''), count: 0, unit_ids: [] };
    else if (action === 'seal') {
      if (d.batch) d.batch.sealed = true;
    } else if (action === 'reset') {
      // Batch shipped: release its claims and drop its units (the durable record
      // is the merged PR + closed issues). A claim ref left behind would wedge
      // the issue forever if it were ever re-opened.
      const shipped = d.batch?.unit_ids ?? [];
      const issues = shipped.flatMap(uid => d.units[uid]?.issues ?? []);
      releaseClaim(issues, c.gh, { repo: c.repo, label: true });
      for (const uid of shipped) delete d.units[uid];
      d.batch = null;
    } else {
      c.out(`unknown batch action ${action}`);
      return 2;
    }
    c.cache.save(d);
    c.out(JSON.stringify(d.batch));
    return 0;
  },

  'verify-set'(c, a) {
    const d = c.cache.load();
    const prev = d.verify;
    // An omitted --detail must not blank the checklist the seal recorded: the
    // owed->verifying hop carries it to Box-Verify. Only an explicit --detail
    // replaces it, and only for the same sha.
    const detail = clip(String(a.detail ?? '')) || (prev?.sha === String(a._[0]) ? (prev?.detail ?? '') : '');
    d.verify = { sha: String(a._[0]), status: String(a._[1]), detail, since: c.now() };
    c.cache.save(d);
    if (a.pr) mirrorVerifyLabel(c.gh, c.repo, Number(a.pr), d.verify.status);
    c.out(JSON.stringify(d.verify));
    return 0;
  },

  /** Read verify state; a `verifying` with no progress >20 min = a dead agent. */
  'verify-get'(c) {
    const d = c.cache.load();
    if (d.verify?.status === 'verifying' && c.now() - d.verify.since > 1200) {
      d.verify.status = 'owed';
      c.cache.save(d);
    }
    c.out(JSON.stringify(d.verify ?? null, null, 2));
    return 0;
  },

  note(c, a) {
    const d = c.cache.load();
    d.notes.push({ note: clip(String(a._[0] ?? '')), since: c.now() });
    c.cache.save(d);
    c.out(`noted (${c.cache.load().notes.length}/${NOTES_CAP})`);
    return 0;
  },

  /** Park an issue durably in GitHub: one `autoloop:*` label + an optional comment. */
  park(c, a) {
    const state = String(a._[1] ?? '');
    const label = PARK_LABELS[state];
    if (!label) {
      c.out(`unknown park state ${state}; expected ${Object.keys(PARK_LABELS).join('|')}`);
      return 2;
    }
    const issue = Number(a._[0]);
    const d = c.cache.load();
    const parked = parkUnits(d, issue);
    c.cache.save(d);
    // A parked issue must not stay claimed — another instance has to be able to
    // pick it up once the human unparks it.
    releaseClaim([issue], c.gh, { repo: c.repo });
    c.gh([...repoArgs(c.repo), 'issue', 'edit', String(issue), '--add-label', label, '--remove-label', L_QUEUED]);
    if (a.comment) c.gh([...repoArgs(c.repo), 'issue', 'comment', String(issue), '--body', String(a.comment)]);
    c.out(`parked #${issue} -> ${label}${parked.length ? `; units out of rotation: ${parked.join(',')}` : ''}`);
    return 0;
  },

  /** Prune the cache and (re)project the verify label onto the release PR. One-way. */
  mirror(c, a) {
    const d = c.cache.load();
    c.cache.save(d); // save() prunes
    if (a.pr && d.verify) mirrorVerifyLabel(c.gh, c.repo, Number(a.pr), d.verify.status);
    c.out('mirrored + pruned');
    return 0;
  },

  /** Cold start: reconstruct the ephemeral cache from GitHub. */
  rebuild(c, a) {
    const d = freshCache();
    if (a['release-pr']) {
      const pr = ghJson<{ labels?: { name: string }[] }>(
        c.gh,
        [...repoArgs(c.repo), 'pr', 'view', String(a['release-pr']), '--json', 'labels,headRefName'],
        {},
      );
      const labels = new Set((pr.labels ?? []).map(l => l.name));
      if (labels.has(L_VERIFY_FAILED)) d.verify = { sha: '?', status: 'red', detail: 'from label', since: c.now() };
      else if (labels.has(L_VERIFY_PENDING))
        d.verify = { sha: '?', status: 'owed', detail: 'from label', since: c.now() };
    }
    c.cache.save(d);
    c.out('rebuilt cache from GitHub (units re-plan on the next planner run)');
    return 0;
  },

  'eval-done'(c) {
    const d = c.cache.load();
    d.last_codebase_eval = c.now();
    c.cache.save(d);
    c.out(`last_codebase_eval=${d.last_codebase_eval}`);
    return 0;
  },

  /** Advisory single-writer lock for THIS checkout (stale after LOCK_STALE_S). */
  lock(c) {
    const d = c.cache.load();
    const now = c.now();
    if (d.lock && now - d.lock.since < LOCK_STALE_S && d.lock.pid !== process.pid) {
      c.out('locked');
      return 3;
    }
    d.lock = { pid: process.pid, since: now };
    c.cache.save(d);
    c.out('acquired');
    return 0;
  },

  unlock(c) {
    const d = c.cache.load();
    d.lock = null;
    c.cache.save(d);
    c.out('released');
    return 0;
  },
};

// ---------------------------------------------------------------------- runner

export interface Args {
  _: string[];
  [k: string]: unknown;
}

export function runVerb(verb: string, argv: string[], ctx: Omit<Ctx, 'out'> & { out?: (s: string) => void }): number {
  const fn = VERBS[verb];
  if (!fn) {
    (ctx.out ?? console.log)(`unknown verb ${verb}; expected ${Object.keys(VERBS).join('|')}`);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      branch: { type: 'string' },
      detail: { type: 'string' },
      comment: { type: 'string' },
      exclude: { type: 'string' },
      order: { type: 'string' },
      prune: { type: 'boolean' },
      pr: { type: 'string' },
      'release-pr': { type: 'string' },
    },
  });
  return fn({ ...ctx, out: ctx.out ?? (s => console.log(s)) } as Ctx, { ...values, _: positionals });
}

// -------------------------------------------------------------- global args

export interface GlobalArgs {
  offline: boolean;
  repo?: string;
  cachePath: string;
  rest: string[];
}

const GLOBAL_FLAGS = new Set(['--offline']);
const GLOBAL_VALUE_FLAGS = new Set(['--repo', '--cache']);

/**
 * Split the process-wide flags off the front of the verb's own argv.
 *
 * Scanned, never index-arithmetic'd (#2644): the previous shape derived
 * `indexOf('--repo') + 1` and filtered that index out, so an ABSENT flag gave
 * `-1 + 1 === 0` and silently ate `argv[0]` — the verb itself. Every invocation
 * without BOTH flags therefore printed usage and exited 2, and only the one
 * test that happened to pass both flags exercised the entry point at all.
 * Exported so the entry point's arg handling is directly assertable.
 */
export function splitGlobalArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): GlobalArgs {
  let offline = false;
  let repo: string | undefined;
  let cachePath: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (GLOBAL_FLAGS.has(a)) {
      offline = true;
    } else if (GLOBAL_VALUE_FLAGS.has(a)) {
      const value = argv[++i]; // the flag consumes exactly its own value
      if (a === '--repo') repo = value;
      else cachePath = value;
    } else {
      rest.push(a);
    }
  }
  return {
    offline,
    repo: repo ?? env.AUTOLOOP_REPO,
    cachePath: cachePath ?? env.AUTOLOOP_CACHE ?? CACHE_DEFAULT,
    rest,
  };
}

// ---- everything below runs only when invoked as a script ----

function main(): void {
  const { offline, repo, cachePath, rest } = splitGlobalArgs(process.argv.slice(2));
  const verb = rest.shift();
  if (!verb) {
    console.log(`usage: npm run autoloop:queue -- <verb> [args]\nverbs: ${Object.keys(VERBS).join(' ')}`);
    process.exit(2);
  }
  const gh = offline ? OFFLINE_GH : realGh;
  process.exit(
    runVerb(verb, rest, {
      cache: new Cache(cachePath),
      gh,
      repo,
      offline,
      // NOT local HEAD (#2646): the batch branch is never pushed mid-build, so
      // the remote does not have that object and the claim create 422s.
      sha: () => resolveClaimSha(gh, { repo }),
      now: () => Math.floor(Date.now() / 1000),
    }),
  );
}

const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('autoloop-queue.ts') || invokedPath.endsWith('autoloop-queue.js')) main();
