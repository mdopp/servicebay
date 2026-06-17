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
  const { exec, mountpoint, catalog, shareGid, hashOf, immich, dryRun = false, now = Date.now, onProgress } = opts;
  assertShareGid(shareGid);

  const results: ApplyResultItem[] = [];
  let applied = 0;
  let bytes = 0;
  let done = 0;

  for (const item of plan.items) {
    const outcome = await applyItem(item, {
      exec, mountpoint, catalog, shareGid, hashOf, immich, dryRun, now,
    });
    results.push({ sourcePath: item.record.sourcePath, target: item.target, outcome });
    if (outcome === 'copied' || outcome === 'photo-uploaded' || outcome === 'superseded') {
      applied += 1;
      bytes += item.record.size;
    }
    done += 1;
    onProgress?.({ copied: applied, bytes, done, total: plan.items.length });
  }

  return { items: results, applied };
}

interface ItemCtx {
  exec: SafeExec;
  mountpoint: string;
  catalog: ImportCatalog;
  shareGid: number;
  hashOf: HashResolver;
  immich?: ImmichConfig;
  dryRun: boolean;
  now: () => number;
}

async function applyItem(item: ImportPlanItem, ctx: ItemCtx): Promise<ApplyOutcome> {
  if (item.action === 'skip-junk') return 'skipped-junk';
  if (item.action === 'skip-dupe') return 'skipped-dupe';

  // Photos go to Immich, never into file-share.
  if (item.category === 'photos') {
    if (ctx.dryRun) return 'dry-run';
    await uploadPhoto(item.record, ctx);
    return 'photo-uploaded';
  }

  const target = item.target;
  if (target === null) return 'skipped-junk';

  const sha = ctx.hashOf(item.record);

  // RESUMABILITY: this exact content already at this exact target → done.
  if (ctx.catalog.has(sha, target)) return 'skipped-cataloged';

  if (ctx.dryRun) return 'dry-run';

  // Validate the destination stays under file-share/data/ BEFORE any host I/O.
  const dest = resolveShareTarget(target);
  const src = `${ctx.mountpoint}/${stripLeadingSlash(item.record.sourcePath)}`;

  let outcome: ApplyOutcome = 'copied';
  if (item.action === 'conflict') {
    await supersedeExisting(target, ctx);
    outcome = 'superseded';
  }

  await copyAndOwn(src, dest, ctx);
  ctx.catalog.upsert(catalogEntry(sha, target, item.record, ctx.now()));
  return outcome;
}

/** rsync the source file into its destination, then chown to the share gid. */
async function copyAndOwn(src: string, dest: string, ctx: ItemCtx): Promise<void> {
  const destDir = dest.slice(0, dest.lastIndexOf('/'));
  // Privileged (#1713): the file-share data tree under /mnt/data is owned by
  // container subuids, not `core`, so creating dirs, rsync-copying in, and
  // chowning all need root. The destination path is validated to stay under
  // file-share/data/ by resolveShareTarget BEFORE this runs — privilege does
  // not relax that guard.
  await runOk(ctx.exec, ['mkdir', '-p', destDir], 'mkdir dest dir', { sudo: true });
  // `-a` preserves metadata; the source mount is read-only so this only reads
  // from it. Explicit src/dest argv — no globbing, no `--delete`.
  await runOk(ctx.exec, ['rsync', '-a', src, dest], 'rsync', { sudo: true });
  // chown to the share GID ONLY (`:<gid>` leaves the uid untouched). Single
  // file target — never recursive, never an arbitrary path.
  await runOk(ctx.exec, ['chown', `:${ctx.shareGid}`, dest], 'chown', { sudo: true });
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
  const src = `${ctx.mountpoint}/${stripLeadingSlash(record.sourcePath)}`;
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
