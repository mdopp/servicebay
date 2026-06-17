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

import { ImportCatalog } from './catalog';
import { buildInventory } from './inventory';
import { buildPlan, type HashResolver } from './dedup';
import { classifyRecord } from './classify';
import { listBlockDevices, mountReadOnly, unmount, type BlockDevice } from './mounter';
import { hashRecords, hashSourceFile, scanMount } from './hostScan';
import { applyPlan, type ApplyResult, type ImmichConfig } from './plan';
import {
  createScanJob,
  finalizeScan,
  getSession,
  markApplied,
  markApplying,
  markError,
  setProgress,
  sessionHashes,
  type ScanSession,
  __clearSessions as clearSessionStore,
} from './sessionStore';
import type { SafeExec } from './hostExec';
import type { Category, ImportPlan, ImportRecord } from './types';

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
}

export interface ScanOptions {
  exec: SafeExec;
  device: string;
  /** Catalog DB path (resume + cross-disk delta dedup). */
  catalogPath: string;
}

export interface ApplyOptions {
  exec: SafeExec;
  /** The token from a prior {@link scanDevice} — REQUIRED. The review gate. */
  sessionId: string;
  /** Numeric gid that owns file-share data; copied files are chown'd to it. */
  shareGid: number;
  /** Immich config for the photo pass; omit to skip photos. */
  immich?: ImmichConfig;
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
 * The scan work proper: mount → walk → hash → plan → finalize the session. Runs
 * either inline ({@link scanDevice}) or as the detached body of {@link startScan}.
 * Streams progress into the session as it goes (step + scanned/hashed counts).
 */
async function runScan(sessionId: string, opts: ScanOptions): Promise<ScanResult> {
  const { exec, device, catalogPath } = opts;
  await setProgress(sessionId, { step: 'mount' });
  const mountpoint = await mountReadOnly(exec, device);
  try {
    await setProgress(sessionId, { step: 'walk' });
    const files = await scanMount(exec, mountpoint);
    const records = buildInventory(files);
    await setProgress(sessionId, { step: 'hash', scanned: records.length });

    // Pre-hash only the size-collision candidates host-side, then hand dedup a
    // synchronous resolver over the resulting map (the engine stays sync).
    const candidates = sizeCollisionCandidates(records);
    const hashes = await hashRecords(exec, candidates, (hashed, total) => {
      void setProgress(sessionId, { hashed, total });
    });
    const hashOf: HashResolver = record => {
      const h = hashes.get(record.sourcePath);
      if (h === undefined) {
        throw new Error(`disk-import: missing pre-computed hash for ${record.sourcePath}`);
      }
      return h;
    };

    await setProgress(sessionId, { step: 'plan' });
    const catalog = new ImportCatalog(catalogPath);
    let plan: ImportPlan;
    try {
      plan = buildPlan(records, hashOf, { catalog });
    } finally {
      catalog.close();
    }

    await finalizeScan(sessionId, { plan, hashes });

    return {
      sessionId,
      device,
      totalFiles: plan.items.length,
      totalBytes: plan.items.reduce((sum, i) => sum + i.record.size, 0),
      categories: summarizeCategories(plan),
      actions: buildActions(plan, records),
    };
  } finally {
    // Always release the read-only mount; a failed scan must not leave it held.
    await unmount(exec, mountpoint).catch(() => {});
  }
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
  const { exec, sessionId, shareGid, immich } = opts;
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

    const result = await applyPlan(session.plan, {
      exec,
      mountpoint,
      catalog,
      shareGid,
      hashOf,
      immich,
      onProgress: p => {
        void setProgress(sessionId, {
          step: 'copy',
          copied: p.copied,
          bytes: p.bytes,
          total: p.total,
        });
      },
    });
    await markApplied(sessionId, result.applied); // one apply per reviewed plan
    return result;
  } finally {
    catalog.close();
    await unmount(exec, mountpoint).catch(() => {});
  }
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
}

export async function getImportJob(sessionId: string): Promise<ImportJobStatus | null> {
  const s = await getSession(sessionId);
  if (!s) return null;
  const status: ImportJobStatus = {
    sessionId: s.id,
    device: s.device,
    phase: s.phase,
    progress: s.progress,
    error: s.error,
    applied: s.applied,
  };
  if (s.plan) {
    status.review = {
      sessionId: s.id,
      device: s.device,
      totalFiles: s.plan.items.length,
      totalBytes: s.plan.items.reduce((sum, i) => sum + i.record.size, 0),
      categories: summarizeCategories(s.plan),
      actions: buildActions(s.plan, s.plan.items.map(i => i.record)),
    };
  }
  return status;
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
  for (const item of plan.items) {
    const writes = item.action === 'copy' || item.action === 'conflict';
    if (writes && item.category !== 'photos' && !hashes.has(item.record.sourcePath)) {
      hashes.set(item.record.sourcePath, await hashSourceFile(exec, item.record.sourcePath));
    }
  }
  return hashes;
}

/** Records whose size is shared with another record — the only dedup candidates. */
function sizeCollisionCandidates(records: ImportRecord[]): ImportRecord[] {
  const counts = new Map<number, number>();
  for (const r of records) counts.set(r.size, (counts.get(r.size) ?? 0) + 1);
  return records.filter(r => (counts.get(r.size) ?? 0) > 1);
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
