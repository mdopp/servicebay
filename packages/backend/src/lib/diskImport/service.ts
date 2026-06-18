// Disk-import — UI-card orchestration service (issue #1697).
//
// The thin layer the three API routes (`list-devices` / `scan` / `apply`) wire
// to. It owns NO new import logic: it sequences the existing engine
// (inventory → classify → dedup → plan, #1693), the host mount/apply (#1694) and
// the host-side scan helpers (hostScan.ts) into the device → scan → review →
// confirm → apply flow the card drives.
//
// THE REVIEW GATE (same safety as the CLI): `scanDevice` produces a plan and a
// session token, but writes NOTHING. `applyImportPlan` refuses unless it is
// handed back the token of a plan that was scanned in THIS process and not yet
// applied — there is no way to apply an unreviewed plan. Ambiguous folders and
// conflicts surface as Diagnose-style `actions[]`; they annotate the review,
// they do NOT block the rest of the plan (the deterministic plan is complete and
// applicable regardless — the actions are advisory follow-ups).

import { randomUUID } from 'node:crypto';

// Heavy disk-import engine now lives in the resource-capped worker package
// (#1951, slice of #1949). servicebay's in-process orchestration imports it
// from there for now; #1954 retires this in-process heavy path in favour of
// launching the worker container.
import {
  ImportCatalog,
  buildInventory,
  buildPlan,
  type HashResolver,
  classifyRecord,
  buildSubtreeHints,
  isJunk,
  listBlockDevices,
  mountReadOnly,
  unmount,
  type BlockDevice,
  hashPaths,
  hashRecords,
  scanMount,
  applyPlan,
  type ApplyResult,
  autoAssignOwners,
  buildFolderTree,
  dirOfRel,
  topLevelSegment,
  type FolderNode,
  type RoutingResolution,
  type SafeExec,
  type Category,
  type ImportPlan,
  type ImportRecord,
  type Owner,
  type Rule,
} from '@servicebay/disk-import-worker';
import {
  provisionExternalLibraries,
  scanLibrariesForOwners,
  type ImmichAdminConfig,
} from './immichLibraries';
import {
  createScanJob,
  finalizeScan,
  finalizeDedup,
  startDedup,
  setDedupProgress,
  markDedupPartial,
  getSession,
  markApplied,
  markApplying,
  markError,
  setProgress,
  sessionHashes,
  appendLog,
  getSessionStatus,
  abortSession,
  type ScanSession,
  type DedupState,
  type ReviewSummary,
  __clearSessions as clearSessionStore,
} from './sessionStore';

/** A removable partition the card can offer as an import source. */
export interface ImportDevice extends BlockDevice {
  /** Human-friendly label for the picker (`SANDISK (28.7 GB, exfat)`). */
  display: string;
}

/** Per-category rollup shown in the review. */
export interface CategorySummary {
  category: Category;
  files: number;
  bytes: number;
  copy: number;
  skipDupe: number;
  conflict: number;
}

/**
 * A Diagnose-style action: an UNAVOIDABLE decision surfaced for review. It is
 * advisory — the deterministic plan already has a safe default, so leaving an
 * action unresolved does NOT block apply. Mirrors the diagnose probe `actions[]`
 * shape so the card can render it with the existing component.
 */
export interface ImportAction {
  id: string;
  kind: 'ambiguous-folder' | 'conflict';
  /** One-line, plain-language description of the decision. */
  label: string;
  /** The file / folder / target the action is about. */
  subject: string;
  /** What happens if the user does nothing (the safe default). */
  defaultOutcome: string;
}

/**
 * Encodes a node's edited routing for transport (#1915). A serialized `Rule`
 * (every axis optional); the card sends back only the axes the user set per dir.
 */
export type RoutingRules = Record<string, Rule>;

/** The review payload the card shows between scan and confirm. */
export interface ScanResult {
  /** Opaque token that authorises a later apply of THIS reviewed plan. */
  sessionId: string;
  device: string;
  totalFiles: number;
  totalBytes: number;
  categories: CategorySummary[];
  /** Unavoidable decisions for review — advisory, non-blocking. */
  actions: ImportAction[];
  /**
   * The per-folder routing tree the review UI renders (#1915): every directory
   * that holds files, its tally + categories, its explicit rule and its resolved
   * effective rule (inherited where not explicit). The card lets the user edit
   * disposition + owner per node and sends the edited rule map back to apply.
   */
  tree: FolderNode[];
  /** Box users that drive the Owner picker (sourced from the directory). */
  boxUsers: string[];
  /** The disk-default owner seeding the root (`shared` unless the user picks). */
  defaultOwner: Owner;
}

export interface ScanOptions {
  exec: SafeExec;
  device: string;
  /** Catalog DB path (resume + cross-disk delta dedup). */
  catalogPath: string;
  /** Box-user list (drives the Owner picker + exact-match auto-assign). */
  boxUsers?: readonly string[];
}

export interface ApplyOptions {
  exec: SafeExec;
  /** The token from a prior {@link scanDevice} — REQUIRED. The review gate. */
  sessionId: string;
  /** Numeric gid that owns file-share data; copied files are chown'd to it. */
  shareGid: number;
  /**
   * Immich ADMIN-API config (#1904 Decision A). When present, after a photo-
   * writing apply the importer auto-provisions per-user + Shared External
   * Libraries (one stored admin key — NOT per-user keys) and triggers the
   * owning library's scan so Immich indexes the new photos. Omit on a box
   * without Immich; photos still land in `data/<owner>/photos` regardless.
   */
  immich?: ImmichAdminConfig;
  /**
   * The user's edited routing tree (#1915): per-dir explicit rules + the
   * disk-default owner. When present the plan is RE-RESOLVED against these edits
   * before the copy so owner/disposition changes actually move the targets;
   * omit to apply the plan exactly as reviewed.
   */
  routing?: { rules: RoutingRules; defaultOwner?: Owner };
}

/**
 * Build the {@link RoutingResolution} the engine threads through `buildPlan`
 * from an explicit rule map + default owner. `relPathOf` strips the scan
 * mountpoint so a record's absolute `sourcePath` becomes the routing-tree
 * relative coordinate (the same space the explicit-dir keys live in).
 */
function buildRouting(
  mountpoint: string,
  rules: RoutingRules,
  defaultOwner: Owner = 'shared',
): RoutingResolution {
  const explicit = new Map<string, Rule>(Object.entries(rules));
  return {
    relPathOf: record => relPathFor(mountpoint, record.sourcePath),
    explicit,
    rootDefault: defaultOwner === 'shared' ? {} : { owner: defaultOwner },
  };
}

/**
 * #1915: seed the explicit-rule map from the box-user list — every top-level
 * source dir named EXACTLY like a box user is pre-assigned that owner (overridable
 * in the review). Returns the map keyed by relative top-level dir.
 */
function seedAutoOwners(
  records: readonly ImportRecord[],
  mountpoint: string,
  boxUsers: readonly string[],
): Map<string, Rule> {
  const topLevelDirs = [
    ...new Set(records.map(r => topLevelSegment(relPathFor(mountpoint, r.sourcePath)))),
  ].filter(d => d !== '');
  return autoAssignOwners(topLevelDirs, boxUsers);
}

/** A record's source path RELATIVE to the scan mountpoint (the tree coordinate). */
function relPathFor(mountpoint: string, sourcePath: string): string {
  const base = mountpoint.replace(/\/+$/, '');
  if (sourcePath === base) return '';
  return sourcePath.startsWith(base + '/')
    ? sourcePath.slice(base.length + 1)
    : sourcePath.replace(/^\/+/, '');
}

/**
 * Enumerate removable partitions that carry a filesystem — the only things the
 * card offers as an import source (a whole-disk node or a bare partition with no
 * fstype isn't importable).
 */
export async function listImportDevices(exec: SafeExec): Promise<ImportDevice[]> {
  const devices = await listBlockDevices(exec);
  return devices
    .filter(d => d.removable && d.fstype !== '')
    .map(d => ({ ...d, display: describeDevice(d) }));
}

function describeDevice(d: BlockDevice): string {
  const name = d.label || d.name;
  return `${name} (${formatBytes(d.size)}, ${d.fstype})`;
}

/**
 * Mount the device READ-ONLY, host-walk it, run the deterministic pipeline, and
 * return the review payload + a session token. The reviewed plan is persisted
 * to the durable session store (#1896) so it survives a backend restart and a
 * reopened card can re-attach by id. Writes NOTHING to the imported host: the
 * source is `-o ro` and the catalog is opened read-only-in-effect (we only read
 * it for delta dedup here; nothing is upserted until apply). The mount is always
 * unmounted before returning, even on error.
 *
 * Synchronous variant (kept for the engine tests + any caller that can wait):
 * creates its own session id and runs the walk/hash/plan inline. The HTTP route
 * uses {@link startScan} instead, which returns the id immediately and runs this
 * same work in the background (#1897) so a large disk never blocks past the HTTP
 * timeout.
 */
export async function scanDevice(opts: ScanOptions): Promise<ScanResult> {
  const { device, catalogPath } = opts;
  const sessionId = randomUUID();
  await createScanJob({ id: sessionId, device, catalogPath });
  return runScan(sessionId, opts);
}

/**
 * Async entry point (#1897). Open a job in `scanning`, kick off the real scan as
 * a detached task, and return the id IMMEDIATELY — no 504 on a large disk. The
 * card polls {@link getImportJob} for live phase + counts and the reviewed
 * plan. Errors are caught and recorded on the session (never propagate — there
 * is no caller awaiting them), mirroring `install/runner.startJob`.
 */
export async function startScan(opts: ScanOptions): Promise<{ jobId: string }> {
  const sessionId = randomUUID();
  await createScanJob({ id: sessionId, device: opts.device, catalogPath: opts.catalogPath });
  void (async () => {
    try {
      await runScan(sessionId, opts);
    } catch (e) {
      await markError(sessionId, e instanceof Error ? e.message : String(e));
    }
  })();
  return { jobId: sessionId };
}

/**
 * The scan work proper. Review-first (#1937): mount → walk → classify + plan on
 * METADATA ONLY (no hashes, dedup deferred) → finalize the session to `reviewed`
 * with the routing tree IMMEDIATELY so the card renders in seconds even on a
 * 177k-file disk; THEN hash the size-collision candidates in the BACKGROUND and
 * re-finalize the plan with real dedup decisions (the card polls `dedup`). Runs
 * inline ({@link scanDevice}) or as the detached body of {@link startScan}.
 *
 * Why this is safe: the apply path's `topUpHashes` re-hashes copy targets and the
 * catalog dedups AT APPLY, so deferring scan-time dedup loses nothing — a first/
 * sparse import dedups correctly when applied. A background hash failure (Part B)
 * degrades dedup to `partial` rather than killing the already-rendered review.
 */
async function runScan(sessionId: string, opts: ScanOptions): Promise<ScanResult> {
  const { exec, device, catalogPath } = opts;
  await setProgress(sessionId, { step: 'mount' });
  const mountpoint = await mountReadOnly(exec, device);
  // Set in the try-body when there are size-collision candidates; the `finally`
  // releases the mount FIRST, then schedules this background dedup pass (#1937).
  let pendingDedup: Parameters<typeof runBackgroundDedup>[0] | undefined;
  try {
    await setProgress(sessionId, { step: 'walk' });
    const files = await scanMount(exec, mountpoint);
    // Drop junk records BEFORE planning (#1932). Junk subtrees (node_modules/.git
    // /bower_components/…) are already pruned at the `find` walk; this is belt-
    // and-suspenders for the junk a path-prune can't express — junk NAMES
    // (thumbs.db/.ds_store) and junk EXTENSIONS (tmp/cache/…). The kept set is
    // what the plan sees, so classification/counts stay junk-free.
    const records = buildInventory(files).filter(r => !isJunk(r));
    await setProgress(sessionId, { step: 'plan', scanned: records.length });

    // #1915: seed the routing tree from the box-user list — a top-level source
    // dir named EXACTLY like a box user is pre-assigned that owner (overridable
    // in the review). The disk-default owner is `shared` until the user picks one.
    const boxUsers = opts.boxUsers ?? [];
    const explicit = seedAutoOwners(records, mountpoint, boxUsers);
    const routing = buildRouting(mountpoint, Object.fromEntries(explicit), 'shared');
    const hints = buildSubtreeHints(records);

    // 1. METADATA-ONLY plan (#1937): no hashes yet. `metadataHashOf` hands every
    //    record a UNIQUE token, so no two files are ever judged identical — dedup
    //    is effectively off and every kept file is `copy` (a real same-target
    //    collision still surfaces as a conflict, which doesn't need a hash). This
    //    is what renders the tree in seconds.
    const planNoDedup = buildPlanWithCatalog(records, metadataHashOf, catalogPath, { hints, routing });

    // The size-collision candidates are the ONLY files dedup ever hashes. Compute
    // the set up front so we can both decide the initial dedup state and drive
    // the background pass.
    const candidates = sizeCollisionCandidates(records);

    await finalizeScan(sessionId, {
      plan: planNoDedup,
      hashes: new Map(),
      mountpoint,
      boxUsers: [...boxUsers],
      autoRules: Object.fromEntries(explicit),
      // Nothing to hash → dedup is already final; otherwise the card shows
      // "checking duplicates…" while the background pass runs.
      dedup: candidates.length === 0 ? 'done' : 'pending',
      dedupTotal: candidates.length,
      // #1945: persist the COMPACT review summary (counts + capped tree) on the
      // status doc so the status poll never loads the 145MB record set.
      summary: buildReviewSummary({ plan: planNoDedup, records, mountpoint, explicit }),
    });

    if (candidates.length > 0) {
      pendingDedup = { sessionId, exec, device, records, candidates, hints, routing, catalogPath };
    }

    return buildScanResult({ sessionId, device, plan: planNoDedup, records, mountpoint, explicit, boxUsers });
  } finally {
    // Always release the read-only mount once the walk+metadata plan is done; a
    // failed scan must not leave it held. The background dedup pass (#1937)
    // re-mounts the same controlled mountpoint itself to read the bytes, so the
    // scan's mount lifetime stays self-contained (no cross-task mount ownership).
    await unmount(exec, mountpoint).catch(() => {});

    // BACKGROUND dedup (#1937): hash the candidates, re-plan with real hashes,
    // re-finalize. Scheduled AFTER the mount is released; it re-mounts read-only
    // for its own pass. Detached so the review is already returned/rendered; a
    // hash failure (Part B) degrades dedup to `partial`, never kills the scan.
    if (pendingDedup) {
      void runBackgroundDedup(pendingDedup);
    }
  }
}

/**
 * Background dedup pass (#1937). Re-mounts the device read-only, hashes the
 * size-collision candidates, re-builds the plan with the REAL content hashes (so
 * skip-dupe decisions resolve), and re-finalizes the reviewed session — all while
 * the card already shows the tree. ALWAYS unmounts. Resilient: a file the hash
 * pass couldn't hash (Part B skip) is simply absent from the map, so it routes to
 * `copy` (un-deduped) and the run is reported `partial`. Never throws into the
 * void (the review is already rendered; a dedup hiccup is non-fatal).
 */
async function runBackgroundDedup(args: {
  sessionId: string;
  exec: SafeExec;
  device: string;
  records: readonly ImportRecord[];
  candidates: ImportRecord[];
  hints: PlanHints;
  routing: RoutingResolution;
  catalogPath: string;
}): Promise<void> {
  const { sessionId, exec, device, records, candidates, hints, routing, catalogPath } = args;
  let mountpoint: string | undefined;
  try {
    await startDedup(sessionId, candidates.length);
    mountpoint = await mountReadOnly(exec, device);
    const hashes = await hashRecords(exec, candidates, (hashed, total) => {
      void setDedupProgress(sessionId, hashed, total);
    });
    // A candidate missing from the map was skipped by the resilient hash pass
    // (Part B) — route it as a plain copy (un-deduped) rather than throwing. The
    // run is `partial` when any candidate couldn't be hashed.
    const hashOf: HashResolver = record => hashes.get(record.sourcePath) ?? uniqueToken(record);
    const allHashed = candidates.every(c => hashes.has(c.sourcePath));
    const plan = buildPlanWithCatalog([...records], hashOf, catalogPath, { hints, routing });
    // #1945: refresh the compact summary — the dedup pass changed skip-dupe
    // counts (and so the per-category rollup). The explicit/auto rules are
    // reconstructed from the routing resolution so the tree matches the scan's.
    const explicit = new Map<string, Rule>(routing.explicit);
    await finalizeDedup(sessionId, {
      plan,
      hashes,
      state: allHashed ? 'done' : 'partial',
      summary: buildReviewSummary({ plan, records: [...records], mountpoint, explicit }),
    });
  } catch (e) {
    // The review is already rendered; a dedup-pass failure must not error the
    // session. Mark dedup `partial` (import un-deduped; apply re-dedups) + log.
    await appendLog(sessionId, `dedup pass failed (review unaffected): ${e instanceof Error ? e.message : String(e)}`);
    await markDedupPartial(sessionId);
  } finally {
    if (mountpoint) await unmount(exec, mountpoint).catch(() => {});
  }
}

/** Build a plan against a freshly-opened catalog (always closed). Shared by the
 *  metadata-only pass and the background dedup pass. */
function buildPlanWithCatalog(
  records: ImportRecord[],
  hashOf: HashResolver,
  catalogPath: string,
  opts: { hints: PlanHints; routing: RoutingResolution },
): ImportPlan {
  const catalog = new ImportCatalog(catalogPath);
  try {
    return buildPlan(records, hashOf, { catalog, hints: opts.hints, routing: opts.routing });
  } finally {
    catalog.close();
  }
}

type PlanHints = ReturnType<typeof buildSubtreeHints>;

/** A per-record unique token used where dedup must be effectively OFF (the
 *  metadata-only plan, and an un-hashable candidate): no two records ever match,
 *  so everything routes to `copy`. Stable per path so repeated builds agree. */
function uniqueToken(record: ImportRecord): string {
  return `nohash:${record.sourcePath}`;
}
const metadataHashOf: HashResolver = uniqueToken;

/**
 * Build the COMPACT review summary (#1945) persisted on the status doc: the
 * counts + per-category rollup + capped routing tree + actions the card renders,
 * WITHOUT the bulk record set. Derived once at finalize/finalize-dedup time so
 * the status poll never re-derives it from (or even loads) the 145MB plan. The
 * store applies the {@link ReviewSummary} tree cap; this produces the full tree.
 */
function buildReviewSummary(args: {
  plan: ImportPlan;
  records: readonly ImportRecord[];
  mountpoint: string;
  explicit: ReadonlyMap<string, Rule>;
}): ReviewSummary {
  const { plan, records, mountpoint, explicit } = args;
  return {
    totalFiles: plan.items.length,
    totalBytes: plan.items.reduce((sum, i) => sum + i.record.size, 0),
    categories: summarizeCategories(plan),
    actions: buildActions(plan, [...records]),
    tree: buildReviewTree(records, plan, mountpoint, explicit, 'shared'),
    boxUsers: [],
    defaultOwner: 'shared',
  };
}

/** Assemble the review {@link ScanResult} the card shows from a finished scan. */
function buildScanResult(args: {
  sessionId: string;
  device: string;
  plan: ImportPlan;
  records: readonly ImportRecord[];
  mountpoint: string;
  explicit: ReadonlyMap<string, Rule>;
  boxUsers: readonly string[];
}): ScanResult {
  const { sessionId, device, plan, records, mountpoint, explicit, boxUsers } = args;
  const summary = buildReviewSummary({ plan, records, mountpoint, explicit });
  return {
    sessionId,
    device,
    totalFiles: summary.totalFiles,
    totalBytes: summary.totalBytes,
    categories: summary.categories as CategorySummary[],
    actions: summary.actions as ImportAction[],
    tree: summary.tree as FolderNode[],
    boxUsers: [...boxUsers],
    defaultOwner: 'shared',
  };
}

/**
 * Apply a previously-scanned plan. REQUIRES a valid `sessionId` from
 * {@link scanDevice} — this is the review gate: there is no path to apply a plan
 * that wasn't scanned + reviewed. The session is read from the durable store
 * (#1896), so it survives a backend restart between scan and apply — a forged/
 * replayed id still can't conjure a plan. Resumable (catalog-backed); the
 * session is consumed (one apply per review) on success.
 */
export async function applyImportPlan(opts: ApplyOptions): Promise<ApplyResult> {
  return runApply(opts);
}

/**
 * Async entry point (#1897). Verify the review gate SYNCHRONOUSLY (so a forged/
 * unreviewed/already-applied id still gets an immediate error), flip the session
 * to `applying`, kick off the apply as a detached task, and return the id. The
 * card polls {@link getImportJob} for live copy progress. Errors are recorded on
 * the session, mirroring `install/runner.startJob`.
 */
export async function startApply(opts: ApplyOptions): Promise<{ jobId: string }> {
  const stored = await getSession(opts.sessionId);
  if (!stored || stored.phase !== 'reviewed' || !stored.plan) {
    throw new Error('disk-import: no reviewed plan for this session — scan + review before applying');
  }
  await markApplying(opts.sessionId);
  void (async () => {
    try {
      await runApply(opts, { gateChecked: true });
    } catch (e) {
      await markError(opts.sessionId, e instanceof Error ? e.message : String(e));
    }
  })();
  return { jobId: opts.sessionId };
}

async function runApply(
  opts: ApplyOptions,
  ctx: { gateChecked?: boolean } = {},
): Promise<ApplyResult> {
  const { exec, sessionId, shareGid, immich, routing: edited } = opts;
  const stored = await getSession(sessionId);
  // `startApply` already verified + flipped the gate to `applying`; the inline
  // path checks `reviewed` here. Either way an unreviewed/forged/consumed id is
  // refused — there is no path to apply a plan that wasn't scanned + reviewed.
  const acceptable = ctx.gateChecked ? stored?.phase === 'applying' : stored?.phase === 'reviewed';
  if (!stored || !acceptable || !stored.plan) {
    throw new Error('disk-import: no reviewed plan for this session — scan + review before applying');
  }
  const session = { ...stored, plan: stored.plan, hashes: sessionHashes(stored) };

  // Re-mount read-only for the apply pass (the scan unmounted it).
  const mountpoint = await mountReadOnly(exec, session.device);
  const catalog = new ImportCatalog(session.catalogPath);
  try {
    // applyPlan writes a catalog row (keyed by sha) for EVERY copied/superseded
    // item, so it needs a hash for each — not just the size-collision set the
    // scan pre-hashed. Top up the map host-side for the to-be-written items.
    const hashes = await topUpHashes(exec, session.plan, session.hashes);
    const hashOf: HashResolver = record => {
      const h = hashes.get(record.sourcePath);
      if (h === undefined) {
        throw new Error(`disk-import: missing hash for ${record.sourcePath}`);
      }
      return h;
    };

    const planToApply = resolvePlanToApply(session.plan, hashOf, session.mountpoint, edited, catalog);

    const result = await applyPlan(planToApply, {
      exec,
      mountpoint,
      catalog,
      shareGid,
      hashOf,
      onProgress: p => {
        void setProgress(sessionId, {
          step: 'copy',
          copied: p.copied,
          bytes: p.bytes,
          total: p.total,
        });
      },
    });

    // #1904: if photos were written and an Immich admin key is configured,
    // auto-provision the External Libraries and scan the owning ones so the new
    // photos get indexed. Best-effort — a scan failure must NOT fail the import
    // (the files are safely on disk; a later provision+scan still finds them).
    if (immich && result.photoOwners.length > 0) {
      await triggerImmichScan(immich, result.photoOwners, sessionId);
    }

    await markApplied(sessionId, result.applied); // one apply per reviewed plan
    return result;
  } finally {
    catalog.close();
    await unmount(exec, mountpoint).catch(() => {});
  }
}

/**
 * Choose the plan to apply (#1915): if the user edited the routing tree in
 * review, RE-RESOLVE against those edits (owner/disposition changes move the
 * targets) before the copy; otherwise apply the reviewed plan exactly as-is. The
 * records are the verbatim ones the scan classified and the mountpoint is stable
 * per device, so the stored scan mountpoint is the relative-path basis.
 */
function resolvePlanToApply(
  plan: ImportPlan,
  hashOf: HashResolver,
  mountpoint: string | undefined,
  edited: { rules: RoutingRules; defaultOwner?: Owner } | undefined,
  catalog: ImportCatalog,
): ImportPlan {
  return edited && mountpoint
    ? replanWithEdits(plan, hashOf, mountpoint, edited, catalog)
    : plan;
}

/**
 * Re-resolve the import plan against the user's edited routing tree (#1915).
 * Runs the SAME deterministic engine the scan ran, but with the edited explicit
 * rule map + disk-default owner, so owner/disposition edits move the targets and
 * re-scope the dedup areas. The records are recovered from the reviewed plan
 * (the scan's verbatim classification inputs); hints are re-derived. The catalog
 * is reused (resumability/delta-dedup parity with the reviewed plan).
 */
function replanWithEdits(
  plan: ImportPlan,
  hashOf: HashResolver,
  mountpoint: string,
  edited: { rules: RoutingRules; defaultOwner?: Owner },
  catalog: ImportCatalog,
): ImportPlan {
  const records = plan.items.map(i => i.record);
  const hints = buildSubtreeHints(records);
  const routing = buildRouting(mountpoint, edited.rules, edited.defaultOwner ?? 'shared');
  return buildPlan(records, hashOf, { catalog, hints, routing });
}

/**
 * Status for a disk-import job (#1897). The poll the card hangs off: returns the
 * current phase + live progress counts, and — once `reviewed` — the review
 * payload (per-category sizing + non-blocking actions[]) so a reopened/restarted
 * card can re-attach to a finished scan, and once `applied` the final count. We
 * read the deterministic engine functions again here (cheap, in-memory) rather
 * than persist the derived review, keeping the stored session minimal.
 */
export interface ImportJobStatus {
  sessionId: string;
  device: string;
  phase: ScanSession['phase'];
  progress: ScanSession['progress'];
  error?: string;
  /** Present once `reviewed` (or later) — the review payload for the card. */
  review?: ScanResult;
  /** Files written this apply, present once `applied`. */
  applied?: number;
  /**
   * Background-dedup sub-state (#1937). Once `reviewed`, this tells the card
   * whether the duplicate check is still running so it can show a non-blocking
   * "checking duplicates… N / M" line WITHOUT gating the (already-rendered) tree.
   * `done`/`partial` = the dedup preview is final. Defaults to `done` for a
   * pre-#1937 session that has no `dedup` field.
   */
  dedup?: DedupState;
  /** Candidate files hashed so far / total candidates for the background dedup
   *  pass (#1937) — drives the "checking duplicates… N / M" line. */
  dedupHashed?: number;
  dedupTotal?: number;
}

export async function getImportJob(sessionId: string): Promise<ImportJobStatus | null> {
  // #1945: the status poll reads ONLY the compact status doc — never the 145MB
  // plan/hashes sidecar. The review payload is served from the persisted
  // `summary` (counts + capped tree, derived once at finalize). A reopened card
  // at any scale loads this in KBs–low MBs, so it never falls back to 'Starting…'.
  // Reaps a dead-worker session to `error` on read (#1943).
  const s = await getSessionStatus(sessionId);
  if (!s) return null;
  // `reviewed` is the only phase that carries a summary; pre-#1945 sessions on
  // disk reached `reviewed` without one — fall back to rebuilding from the plan
  // (loads the sidecar) just for those, so an in-flight upgrade isn't dark.
  const hasReview = s.phase === 'reviewed' || s.phase === 'applying' || s.phase === 'applied';
  const status: ImportJobStatus = {
    sessionId: s.id,
    device: s.device,
    phase: s.phase,
    progress: s.progress,
    error: s.error,
    applied: s.applied,
    // A reopened card re-attaches whether dedup is still pending/running or done
    // (#1937). Only meaningful once the scan has produced a plan/summary.
    dedup: hasReview ? s.dedup ?? 'done' : undefined,
    dedupHashed: s.dedupHashed ?? 0,
    dedupTotal: s.dedupTotal ?? 0,
  };
  if (s.summary) {
    status.review = summaryToReview(s);
  } else if (hasReview) {
    // Pre-#1945 session with no persisted summary — rebuild from the plan once.
    status.review = (await rebuildReviewFromPlan(sessionId)) ?? undefined;
  }
  return status;
}

/** Project the persisted compact {@link ReviewSummary} (#1945) into the card's
 *  {@link ScanResult}. No plan load — this is the hot path. */
function summaryToReview(s: ScanSession): ScanResult {
  const summary = s.summary!;
  return {
    sessionId: s.id,
    device: s.device,
    totalFiles: summary.totalFiles,
    totalBytes: summary.totalBytes,
    categories: summary.categories as CategorySummary[],
    actions: summary.actions as ImportAction[],
    tree: summary.tree as FolderNode[],
    boxUsers: s.boxUsers ?? summary.boxUsers ?? [],
    defaultOwner: (summary.defaultOwner as Owner) ?? 'shared',
  };
}

/** Backward-compat fallback (#1945): a `reviewed` session persisted before the
 *  store split has no `summary` — rebuild the review from the plan (loads the
 *  sidecar). Only hit for sessions on disk across the upgrade. */
async function rebuildReviewFromPlan(sessionId: string): Promise<ScanResult | null> {
  const s = await getSession(sessionId);
  if (!s?.plan) return null;
  const records = s.plan.items.map(i => i.record);
  const explicit = new Map<string, Rule>(Object.entries(s.autoRules ?? {}));
  return {
    sessionId: s.id,
    device: s.device,
    totalFiles: s.plan.items.length,
    totalBytes: s.plan.items.reduce((sum, i) => sum + i.record.size, 0),
    categories: summarizeCategories(s.plan),
    actions: buildActions(s.plan, records),
    tree: s.mountpoint ? buildReviewTree(records, s.plan, s.mountpoint, explicit, 'shared') : [],
    boxUsers: s.boxUsers ?? [],
    defaultOwner: 'shared',
  };
}

/**
 * Provision the Immich External Libraries (idempotent) and trigger a scan for
 * each owner that received photos this apply (#1904). Best-effort: any failure
 * is recorded as a progress note but never propagated — photos are already on
 * disk, and a later provision+scan picks them up.
 */
async function triggerImmichScan(
  immich: ImmichAdminConfig,
  photoOwners: string[],
  sessionId: string,
): Promise<void> {
  try {
    const { libraryIdByOwner } = await provisionExternalLibraries(immich);
    await scanLibrariesForOwners(immich, libraryIdByOwner, photoOwners);
  } catch (e) {
    await appendLog(
      sessionId,
      `Immich library scan skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Abort/dismiss a disk-import session (#1943) — the card's "Start over". Flips a
 * stuck/unwanted session terminal so it stops re-attaching and the user can begin
 * a fresh scan. Idempotent + no-op-safe on an unknown id. Returns the session's
 * resulting phase (or null when the id is unknown).
 */
export async function abortImportJob(sessionId: string): Promise<{ phase: ScanSession['phase'] } | null> {
  const s = await abortSession(sessionId);
  if (!s) return null;
  return { phase: s.phase };
}

/** Test seam: drop all persisted sessions. */
export async function __clearSessions(): Promise<void> {
  await clearSessionStore();
}

/**
 * Top up the hash map for the apply pass. The scan only pre-hashed size-
 * collision candidates; applyPlan needs a hash for every copied/superseded
 * non-photo item (the catalog row is keyed by sha). The source is mounted
 * read-only, so this only reads. Returns a fresh map (the session's is left
 * untouched).
 */
async function topUpHashes(
  exec: SafeExec,
  plan: ImportPlan,
  base: Map<string, string>,
): Promise<Map<string, string>> {
  const hashes = new Map(base);
  // Collect the still-unhashed write targets, then hash them in ONE batched pass
  // (#1898) instead of a `sha256sum` round-trip per file. Dedup by path so a
  // plan that names the same source twice isn't hashed twice.
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const item of plan.items) {
    const writes = item.action === 'copy' || item.action === 'conflict';
    const p = item.record.sourcePath;
    // Photos now copy like every other category (#1904), so they need a hash
    // for the catalog row too — no longer excluded here.
    if (writes && !hashes.has(p) && !seen.has(p)) {
      seen.add(p);
      missing.push(p);
    }
  }
  const fresh = await hashPaths(exec, missing);
  for (const [p, h] of fresh) hashes.set(p, h);
  return hashes;
}

/** Records whose size is shared with another record — the only dedup candidates. */
function sizeCollisionCandidates(records: ImportRecord[]): ImportRecord[] {
  const counts = new Map<number, number>();
  for (const r of records) counts.set(r.size, (counts.get(r.size) ?? 0) + 1);
  return records.filter(r => (counts.get(r.size) ?? 0) > 1);
}

/**
 * Build the per-folder review tree (#1915) from the planned items. Each file
 * contributes its relative dir + classified category + size; `buildFolderTree`
 * tallies these into one node per directory, attaching the explicit + resolved
 * rule so the card can render inherited-vs-explicit dispositions/owners and the
 * `data/<owner>/<category>/…` target preview.
 */
function buildReviewTree(
  records: readonly ImportRecord[],
  plan: ImportPlan,
  mountpoint: string,
  explicit: ReadonlyMap<string, Rule>,
  defaultOwner: Owner,
): FolderNode[] {
  // The plan classified every record; map each to its dir + category for the tally.
  const catByPath = new Map<string, Category>();
  for (const item of plan.items) catByPath.set(item.record.sourcePath, item.category);
  const files = records.map(r => ({
    dir: dirOfRel(relPathFor(mountpoint, r.sourcePath)),
    category: catByPath.get(r.sourcePath) ?? 'documents',
    size: r.size,
  }));
  const rootDefault = defaultOwner === 'shared' ? {} : { owner: defaultOwner };
  return buildFolderTree(files, explicit, rootDefault);
}

function summarizeCategories(plan: ImportPlan): CategorySummary[] {
  const byCat = new Map<Category, CategorySummary>();
  for (const item of plan.items) {
    const s = byCat.get(item.category) ?? {
      category: item.category,
      files: 0,
      bytes: 0,
      copy: 0,
      skipDupe: 0,
      conflict: 0,
    };
    s.files += 1;
    s.bytes += item.record.size;
    if (item.action === 'copy') s.copy += 1;
    else if (item.action === 'skip-dupe') s.skipDupe += 1;
    else if (item.action === 'conflict') s.conflict += 1;
    byCat.set(item.category, s);
  }
  return [...byCat.values()].sort((a, b) => (a.category < b.category ? -1 : 1));
}

/**
 * Derive the review `actions[]`. Two sources of UNAVOIDABLE input:
 *   - conflicts: two different files want the same target (one is parked in
 *     `_superseded/` by default — the action lets the user pick the keeper);
 *   - ambiguous folders: a record the deterministic classifier couldn't place
 *     (it defaulted to `documents`; the action lets the user re-file it).
 * Each action carries its safe `defaultOutcome` — the plan applies fine if the
 * user resolves none of them, so they never block the flow.
 */
function buildActions(plan: ImportPlan, records: ImportRecord[]): ImportAction[] {
  const actions: ImportAction[] = [];

  for (const c of plan.conflicts) {
    actions.push({
      id: `conflict:${c.target}`,
      kind: 'conflict',
      label: `Two different files both map to ${c.target}`,
      subject: c.target,
      defaultOutcome: 'Keep the newer file; the older one is parked in _superseded/ (nothing deleted).',
    });
  }

  // A record the deterministic rules couldn't classify (no extension match, no
  // residue classifier) fell through to `documents` in the plan — flag it so the
  // user can re-file ambiguous media / docs. classifyRecord(record) === null is
  // exactly the undecidable residue (#1695's review target).
  for (const record of records) {
    if (classifyRecord(record) === null) {
      actions.push({
        id: `ambiguous:${record.sourcePath}`,
        kind: 'ambiguous-folder',
        label: `Couldn't auto-sort ${record.name}`,
        subject: record.sourcePath,
        defaultOutcome: 'Filed under documents/ — open to re-file it (e.g. music vs audiobook).',
      });
    }
  }

  return actions;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
