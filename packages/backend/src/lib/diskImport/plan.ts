// Disk-import — apply an APPROVED plan to the host (issue #1694).
//
// Takes the deterministic ImportPlan (from dedup.ts) the operator approved and
// realises it on the host, via the agent's `safe_exec` path only:
//   - non-photos  → `rsync` from the (read-only) mount into
//                    `file-share/data/<category>/…`
//   - photos      → `immich` CLI upload (server-side checksum dedup); photos do
//                    NOT land in file-share.
//   - conflict    → the superseded version is MOVED to
//                    `file-share/data/_superseded/<date>/<target>` (nothing is
//                    deleted), then the newer file is copied in.
//   - ownership   → each copied file is `chown`ed to the share gid so the
//                    containers can read it.
//   - catalog     → every done file is upserted into the catalog, which makes
//                    the whole apply RESUMABLE: an interrupted run re-runs and
//                    skips anything already cataloged (same sha+target).
//
// SECURITY: every destination path is validated to stay inside
// `file-share/data/` (resolveShareTarget / resolveSupersededPath); a malicious
// filename on the source disk can't escape the share. `chown` is restricted to
// the resolved share gid (`:<gid>`) — never an arbitrary uid, never recursive
// over an arbitrary path. The source mount is read-only (mounter.ts), so rsync
// only ever reads from it.

import { ImportCatalog, type CatalogEntry } from './catalog';
import {
  resolveShareTarget,
  resolveSupersededPath,
  type SafeExec,
} from './hostExec';
import type { HashResolver } from './dedup';
import type { ImportPlan, ImportPlanItem, ImportRecord } from './types';

/** How a single planned item was handled in this apply pass. */
export type ApplyOutcome =
  | 'copied'
  | 'photo-uploaded'
  | 'superseded'
  | 'skipped-junk'
  | 'skipped-dupe'
  | 'skipped-cataloged'
  | 'dry-run';

export interface ApplyResultItem {
  sourcePath: string;
  target: string | null;
  outcome: ApplyOutcome;
}

export interface ApplyResult {
  items: ApplyResultItem[];
  /** Count of files actually written/uploaded this pass (excludes skips). */
  applied: number;
}

export interface ApplyOptions {
  exec: SafeExec;
  /** Absolute mountpoint of the (read-only) source, e.g. from mountReadOnly. */
  mountpoint: string;
  /** Catalog for resumability + delta dedup. Required — it's the resume basis. */
  catalog: ImportCatalog;
  /**
   * Numeric gid that owns existing `file-share/data` content (rootless-podman
   * subgid). Copied files are `chown :<gid>` so containers can read them. Must
   * be a non-negative integer — never a name, never arbitrary uid:gid.
   */
  shareGid: number;
  /** Resolves a record's sha256 (for the catalog row). Host hashes the bytes. */
  hashOf: HashResolver;
  /** Immich apply config; omit to skip the photo pass. */
  immich?: ImmichConfig;
  /** Don't touch the host — just compute the outcome set. */
  dryRun?: boolean;
  /** Clock for deterministic dates/tests. */
  now?: () => number;
  /**
   * Called after every item is handled so a background apply can stream live
   * progress (#1897). `copied` counts files written/uploaded this pass,
   * `bytes` their summed size, `done`/`total` the item cursor.
   */
  onProgress?: (p: { copied: number; bytes: number; done: number; total: number }) => void;
}

export interface ImmichConfig {
  /** Immich server URL, e.g. `http://immich-server:2283`. */
  serverUrl: string;
  /** API key for the upload. Passed via env to the CLI container, not argv. */
  apiKey: string;
  /** CLI image; defaults to the upstream immich-cli. */
  image?: string;
}

const DEFAULT_IMMICH_IMAGE = 'ghcr.io/immich-app/immich-cli';

/**
 * How many copied files to group into one batched `mkdir`/`chown` flush (#1898).
 * The apply pass used to issue THREE sudo agent round-trips per copied file
 * (`mkdir -p`, `rsync`, `chown`); now the dir-creation and ownership are batched
 * across a chunk (`mkdir -p <dirs…>`, `chown :gid <files…>`) so a big disk no
 * longer costs one mkdir + one chown round-trip per file. rsync stays per-file
 * (one byte-copy invocation each) so the catalog row — the resume marker — is
 * only written once a file is fully copied AND chowned.
 */
const COPY_BATCH_SIZE = 256;

/** Map epoch-ms to a stable `YYYY-MM-DD` bucket for the _superseded tree. */
function dateBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A numeric, non-negative gid (no names, no uid component). */
function assertShareGid(gid: number): void {
  if (!Number.isInteger(gid) || gid < 0) {
    throw new Error(`disk-import: shareGid must be a non-negative integer, got ${JSON.stringify(gid)}`);
  }
}

/**
 * Apply an approved plan. Idempotent + resumable: items already in the catalog
 * (same sha + target) are skipped without re-copying, so an interrupted apply
 * can simply be re-run.
 */
export async function applyPlan(plan: ImportPlan, opts: ApplyOptions): Promise<ApplyResult> {
  const { exec, catalog, shareGid, hashOf, immich, dryRun = false, now = Date.now, onProgress } = opts;
  assertShareGid(shareGid);
  const ctx: ItemCtx = { exec, catalog, shareGid, hashOf, immich, dryRun, now };

  const results: ApplyResultItem[] = [];
  // Items that need a host copy (`copied`/`superseded`) are queued and flushed in
  // batches so `mkdir`/`chown` aren't one agent round-trip per file (#1898);
  // everything else (skips, photos, dry-run, already-cataloged) resolves inline.
  // The progress cursor is shared across both paths so the live count advances
  // for every item in plan order.
  const progress = { applied: 0, bytes: 0, done: 0, total: plan.items.length, onProgress };
  let pending: CopyJob[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    await copyBatch(pending, ctx, progress, results);
    pending = [];
  };

  for (const item of plan.items) {
    const planned = await classifyItem(item, ctx);
    if (planned.copy) {
      pending.push(planned.copy);
      if (pending.length >= COPY_BATCH_SIZE) await flush();
      continue;
    }
    // Non-copy outcome: record it and advance the cursor inline.
    results.push({ sourcePath: item.record.sourcePath, target: item.target, outcome: planned.outcome });
    progress.done += 1;
    progress.onProgress?.({ copied: progress.applied, bytes: progress.bytes, done: progress.done, total: progress.total });
  }
  await flush();

  return { items: results, applied: progress.applied };
}

interface ItemCtx {
  exec: SafeExec;
  catalog: ImportCatalog;
  shareGid: number;
  hashOf: HashResolver;
  immich?: ImmichConfig;
  dryRun: boolean;
  now: () => number;
}

/** Shared progress cursor threaded through the inline + batched apply paths. */
interface ProgressCursor {
  applied: number;
  bytes: number;
  done: number;
  total: number;
  onProgress?: ApplyOptions['onProgress'];
}

/** A queued file copy (resolved + validated) awaiting the batched flush. */
interface CopyJob {
  item: ImportPlanItem;
  target: string;
  sha: string;
  src: string;
  dest: string;
  outcome: 'copied' | 'superseded';
}

/**
 * Decide an item's fate WITHOUT issuing the copy: returns either a terminal
 * outcome (skip/photo/dry-run/already-cataloged) or a {@link CopyJob} to be
 * flushed in a batch. Conflict superseding (`mkdir`+`mv` of the existing file)
 * still happens here, in plan order, BEFORE the newer file is queued — exactly
 * as before.
 */
async function classifyItem(
  item: ImportPlanItem,
  ctx: ItemCtx,
): Promise<{ outcome: ApplyOutcome; copy?: undefined } | { outcome?: undefined; copy: CopyJob }> {
  if (item.action === 'skip-junk') return { outcome: 'skipped-junk' };
  if (item.action === 'skip-dupe') return { outcome: 'skipped-dupe' };

  // Photos go to Immich, never into file-share.
  if (item.category === 'photos') {
    if (ctx.dryRun) return { outcome: 'dry-run' };
    await uploadPhoto(item.record, ctx);
    return { outcome: 'photo-uploaded' };
  }

  const target = item.target;
  if (target === null) return { outcome: 'skipped-junk' };

  const sha = ctx.hashOf(item.record);

  // RESUMABILITY: this exact content already at this exact target → done.
  if (ctx.catalog.has(sha, target)) return { outcome: 'skipped-cataloged' };

  if (ctx.dryRun) return { outcome: 'dry-run' };

  // Validate the destination stays under file-share/data/ BEFORE any host I/O.
  const dest = resolveShareTarget(target);
  // `sourcePath` is already absolute incl. the mountpoint (scanMount's `find %p`),
  // and is the verbatim key fed to the host hasher + stored in the catalog — use
  // it directly so rsync reads the real file (no `<mount>/<mount>/…` doubling).
  const src = item.record.sourcePath;

  let outcome: 'copied' | 'superseded' = 'copied';
  if (item.action === 'conflict') {
    await supersedeExisting(target, ctx);
    outcome = 'superseded';
  }

  return { copy: { item, target, sha, src, dest, outcome } };
}

/**
 * Flush a batch of queued copies: one `mkdir -p <dirs…>` for the union of
 * destination dirs, one `rsync` per file (the byte copy — kept per-file so the
 * resume marker tracks exactly which files landed), then one `chown :gid
 * <files…>` + catalog over the files that successfully copied. A file is
 * cataloged ONLY after it is copied AND chowned, so an interrupted run re-copies
 * AND re-chowns anything not yet cataloged — resume semantics are unchanged. If
 * an rsync mid-batch fails, we still chown + catalog the files copied so far
 * before propagating, so a resumed run skips them (no re-copy). Each file
 * advances the shared progress cursor as it's copied.
 */
async function copyBatch(
  jobs: CopyJob[],
  ctx: ItemCtx,
  progress: ProgressCursor,
  results: ApplyResultItem[],
): Promise<void> {
  // Pre-create every destination directory in one privileged call (#1713 guards
  // still hold — every dest was resolved under file-share/data/).
  const dirs = [...new Set(jobs.map(j => j.dest.slice(0, j.dest.lastIndexOf('/'))))];
  await runOk(ctx.exec, ['mkdir', '-p', ...dirs], 'mkdir dest dirs', { sudo: true });

  // rsync each file (per-file byte copy, no globbing / --delete), advancing the
  // progress cursor as we go so the live count still ticks within the batch.
  // Track the files that actually landed so a mid-batch failure still chowns +
  // catalogs them (resume parity with the old per-file path).
  const copied: CopyJob[] = [];
  try {
    for (const job of jobs) {
      await runOk(ctx.exec, ['rsync', '-a', job.src, job.dest], 'rsync', { sudo: true });
      copied.push(job);
      results.push({ sourcePath: job.item.record.sourcePath, target: job.target, outcome: job.outcome });
      progress.applied += 1;
      progress.bytes += job.item.record.size;
      progress.done += 1;
      progress.onProgress?.({ copied: progress.applied, bytes: progress.bytes, done: progress.done, total: progress.total });
    }
  } finally {
    await finalizeCopied(copied, ctx);
  }
}

/**
 * chown (group-only) + catalog the files that successfully rsync'd this batch.
 * Runs even when a mid-batch rsync threw, so every fully-copied file is marked
 * done before the error propagates (resume skips it next pass).
 */
async function finalizeCopied(copied: CopyJob[], ctx: ItemCtx): Promise<void> {
  if (copied.length === 0) return;
  // chown to the share GID ONLY (`:<gid>` leaves uid untouched; never recursive,
  // never an arbitrary path).
  await runOk(ctx.exec, ['chown', `:${ctx.shareGid}`, ...copied.map(j => j.dest)], 'chown', { sudo: true });
  for (const job of copied) {
    ctx.catalog.upsert(catalogEntry(job.sha, job.target, job.item.record, ctx.now()));
  }
}

/**
 * Move the file currently at `target` into the dated `_superseded/` tree so the
 * newer (conflicting) version can take its place — nothing is deleted.
 */
async function supersedeExisting(target: string, ctx: ItemCtx): Promise<void> {
  const current = resolveShareTarget(target);
  const parked = resolveSupersededPath(`${dateBucket(ctx.now())}/${stripLeadingSlash(target)}`);
  const parkedDir = parked.slice(0, parked.lastIndexOf('/'));
  // Privileged (#1713): both the existing file and the _superseded tree live
  // under the root-owned file-share data root. `current` and `parked` are both
  // resolved under file-share/data/ (resolveShareTarget / resolveSupersededPath)
  // — neither can escape the share root.
  await runOk(ctx.exec, ['mkdir', '-p', parkedDir], 'mkdir superseded dir', { sudo: true });
  await runOk(ctx.exec, ['mv', current, parked], 'mv to _superseded', { sudo: true });
}

/** Upload a single photo file to Immich via the CLI container (checksum dedup). */
async function uploadPhoto(record: ImportRecord, ctx: ItemCtx): Promise<void> {
  if (!ctx.immich) {
    throw new Error('disk-import: photo in plan but no immich config provided');
  }
  const { serverUrl, apiKey, image = DEFAULT_IMMICH_IMAGE } = ctx.immich;
  // Already-absolute source path (see classifyItem) — no mountpoint re-prefixing.
  const src = record.sourcePath;
  // Mount the source file read-only into the CLI container; pass the API key
  // via env (-e), never on the argv (so it can't leak into a process listing).
  await runOk(
    ctx.exec,
    [
      'podman', 'run', '--rm',
      '-e', `IMMICH_INSTANCE_URL=${serverUrl}`,
      '-e', `IMMICH_API_KEY=${apiKey}`,
      '-v', `${src}:/import/${baseOf(src)}:ro`,
      image, 'upload', '/import',
    ],
    'immich upload',
  );
}

function catalogEntry(sha: string, target: string, record: ImportRecord, atMs: number): CatalogEntry {
  return { sha256: sha, target, sourcePath: record.sourcePath, size: record.size, importedAtMs: atMs };
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

function baseOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

async function runOk(
  exec: SafeExec,
  argv: string[],
  what: string,
  options?: { sudo?: boolean },
): Promise<void> {
  const { code, stderr } = await exec(argv, options);
  if (code !== 0) {
    throw new Error(`disk-import: ${what} failed (code ${code}): ${stderr}`);
  }
}
