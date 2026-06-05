#!/usr/bin/env node
/**
 * `disk-import` CLI (#1696): run the full disk-import pipeline with a human
 * review gate, so a real disk can be imported before the UI card (#1697) exists.
 *
 * It is a thin argv + readline shell around the deterministic engine
 * (`packages/backend/src/lib/diskImport/`, #1693) and the host-apply path
 * (#1694). It mirrors `scripts/sb-config-upload.ts`: argv parsing, an injectable
 * IO seam (`log` / `confirm`), a clean `error: <message>` on user-facing failure.
 *
 * Pipeline: walk the mount → inventory → classify → dedup → plan, print a
 * per-category SIZING REPORT + move-plan summary, then STOP at the review gate.
 *
 *   - `--dry-run` (and the no-flag default) compute + print the plan and touch
 *     NOTHING on the host. Safe by default.
 *   - `--apply` is the only path that performs host I/O, and only AFTER an
 *     explicit confirmation. The apply is resumable: items already in the
 *     catalog (same sha + target) are skipped, so an interrupted run can re-run.
 *
 * Run: `npm run disk-import -- --mount /run/media/usb --dry-run`
 *      `npm run disk-import -- --mount /run/media/usb --apply`
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildInventory, type ScannedFile } from '../packages/backend/src/lib/diskImport/inventory.js';
import { buildPlan, type HashResolver } from '../packages/backend/src/lib/diskImport/dedup.js';
import { classifyRecord } from '../packages/backend/src/lib/diskImport/classify.js';
import { ImportCatalog } from '../packages/backend/src/lib/diskImport/catalog.js';
import { applyPlan, type ApplyResult, type ImmichConfig } from '../packages/backend/src/lib/diskImport/plan.js';
import type { SafeExec } from '../packages/backend/src/lib/diskImport/hostExec.js';
import type { Category, ImportPlan, ImportRecord } from '../packages/backend/src/lib/diskImport/types.js';

/** Thrown for user-facing failures (bad args, abort) so the CLI prints a clean
 *  `error: <message>` instead of a stack trace. */
export class DiskImportError extends Error {}

export interface DiskImportOptions {
  /** Absolute path the source disk is mounted at (the tree to import). */
  mount: string;
  /** `apply` performs host I/O (after confirmation); `dry-run` touches nothing. */
  mode: 'dry-run' | 'apply';
  /** Catalog DB path (resume basis). `:memory:` for an ephemeral dry-run. */
  catalog: string;
  /** Node the agent runs the host-apply commands on. */
  node: string;
  /** Numeric gid that owns file-share content; copied files are chown'd to it. */
  shareGid: number;
}

export const USAGE = `Usage: disk-import --mount <path> [--dry-run | --apply] [options]

Run the disk-import pipeline (inventory -> classify -> dedup -> plan), print a
per-category sizing report and the move-plan, then stop at the review gate. The
default is a dry run: it computes and prints the plan and touches NOTHING on the
host. Only --apply (after an explicit confirmation) performs host I/O.

Options:
  --mount <path>     Path the source disk is mounted at (required)
  --dry-run          Compute + print the plan only; touch nothing (default)
  --apply            Apply the plan to the host (requires confirmation; resumable)
  --catalog <path>   Import catalog DB path (default: :memory: for dry-run)
  --node <name>      Node to run host-apply commands on (default: default)
  --share-gid <gid>  Numeric gid that owns file-share data (default: 1024)
  --help, -h         Show this help`;

const DEFAULT_SHARE_GID = 1024;

/**
 * Parse `process.argv.slice(2)`. Returns `{ help: true }` for --help, or a
 * validated `DiskImportOptions`. Throws `DiskImportError` on malformed input.
 * Defaults to `dry-run` (safe) when neither --dry-run nor --apply is given.
 */
interface ArgDraft {
  mount?: string;
  mode?: 'dry-run' | 'apply';
  catalog?: string;
  node: string;
  shareGid: number;
}

/** Set `mode`, rejecting a conflicting mode flag. */
function setMode(draft: ArgDraft, mode: 'dry-run' | 'apply'): void {
  if (draft.mode && draft.mode !== mode) {
    throw new DiskImportError('--dry-run and --apply are mutually exclusive');
  }
  draft.mode = mode;
}

/** Apply one value-taking flag (`--mount`/`--catalog`/`--node`/`--share-gid`). */
function applyValueArg(draft: ArgDraft, arg: string, value: string | undefined): void {
  if (value === undefined) throw new DiskImportError(`Missing value for ${arg}`);
  if (arg === '--mount') draft.mount = value;
  else if (arg === '--catalog') draft.catalog = value;
  else if (arg === '--node') draft.node = value;
  else {
    const gid = Number(value);
    if (!Number.isInteger(gid) || gid < 0) {
      throw new DiskImportError(`--share-gid must be a non-negative integer, got "${value}"`);
    }
    draft.shareGid = gid;
  }
}

const VALUE_ARGS = new Set(['--mount', '--catalog', '--node', '--share-gid']);

export function parseDiskImportArgs(argv: string[]): DiskImportOptions | { help: true } {
  const draft: ArgDraft = { node: 'default', shareGid: DEFAULT_SHARE_GID };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--dry-run') setMode(draft, 'dry-run');
    else if (arg === '--apply') setMode(draft, 'apply');
    else if (VALUE_ARGS.has(arg)) applyValueArg(draft, arg, argv[++i]);
    else throw new DiskImportError(`Unknown argument: ${arg}`);
  }

  if (!draft.mount) throw new DiskImportError('--mount is required');
  // Safe by default: no explicit mode means dry-run.
  const mode = draft.mode ?? 'dry-run';
  // A dry run never opens a persistent catalog (and never needs one) — default
  // it to an in-memory DB so the dry run can't touch the host catalog either.
  const catalog = draft.catalog ?? (mode === 'apply' ? defaultCatalogPath() : ':memory:');
  return { mount: draft.mount, mode, catalog, node: draft.node, shareGid: draft.shareGid };
}

function defaultCatalogPath(): string {
  return path.join(process.env.DATA_DIR ?? '/mnt/data/servicebay', 'disk-import-catalog.sqlite');
}

/**
 * Recursively walk `mount` and return a metadata-only ScannedFile list. This is
 * a READ-only directory walk (no writes) — the deterministic engine never reads
 * file contents; hashing is deferred to the dedup step and done lazily.
 */
export async function walkMount(mount: string, fsImpl: typeof fs = fs): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsImpl.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const st = await fsImpl.stat(full);
        out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(mount);
  return out;
}

/** Hash a file's bytes (sha256 hex). Used lazily by dedup on size collisions. */
export function hashFileContent(record: ImportRecord): string {
  return createHash('sha256').update(readFileSync(record.sourcePath)).digest('hex');
}

/** Aggregate stats for one category in the sizing report. */
interface CategoryStat {
  count: number;
  bytes: number;
  copy: number;
  skipDupe: number;
  conflict: number;
}

/** Build the per-category sizing rollup from a computed plan. */
export function summarizePlan(plan: ImportPlan): Map<Category, CategoryStat> {
  const stats = new Map<Category, CategoryStat>();
  for (const item of plan.items) {
    const stat = stats.get(item.category) ?? { count: 0, bytes: 0, copy: 0, skipDupe: 0, conflict: 0 };
    stat.count += 1;
    stat.bytes += item.record.size;
    if (item.action === 'copy') stat.copy += 1;
    else if (item.action === 'skip-dupe') stat.skipDupe += 1;
    else if (item.action === 'conflict') stat.conflict += 1;
    stats.set(item.category, stat);
  }
  return stats;
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

/** Render the sizing report + move-plan summary as printable lines. */
export function renderReport(plan: ImportPlan): string[] {
  const lines: string[] = [];
  const stats = summarizePlan(plan);

  lines.push('=== SIZING REPORT (per category) ===');
  const categories = [...stats.keys()].sort();
  for (const category of categories) {
    const s = stats.get(category)!;
    lines.push(
      `  ${category.padEnd(12)} ${String(s.count).padStart(6)} files  ${formatBytes(s.bytes).padStart(10)}` +
        `   (copy ${s.copy}, dupe ${s.skipDupe}, conflict ${s.conflict})`,
    );
  }

  const totalFiles = plan.items.length;
  const totalBytes = plan.items.reduce((sum, i) => sum + i.record.size, 0);
  const toCopy = plan.items.filter(i => i.action === 'copy').length;
  const toSupersede = plan.items.filter(i => i.action === 'conflict').length;
  const skipped = plan.items.filter(i => i.action === 'skip-dupe' || i.action === 'skip-junk').length;

  lines.push('');
  lines.push('=== MOVE PLAN (summary) ===');
  lines.push(`  ${totalFiles} files, ${formatBytes(totalBytes)} scanned`);
  lines.push(`  copy:       ${toCopy}`);
  lines.push(`  supersede:  ${toSupersede} (conflicting target; old version parked in _superseded/)`);
  lines.push(`  skip:       ${skipped} (junk + already-imported duplicates)`);
  lines.push(`  conflicts:  ${plan.conflicts.length}`);

  if (plan.conflicts.length > 0) {
    lines.push('');
    lines.push('  Conflicting targets (review before apply):');
    for (const c of plan.conflicts.slice(0, 20)) {
      lines.push(`    ${c.target}: ${c.incoming.sourcePath} vs existing ${c.existing.sourcePath}`);
    }
    if (plan.conflicts.length > 20) {
      lines.push(`    … and ${plan.conflicts.length - 20} more`);
    }
  }

  return lines;
}

/** IO + host seams — injected so the core is testable without a real box. */
export interface DiskImportIO {
  log: (message: string) => void;
  /** Ask the operator a yes/no question; resolve true to proceed. */
  confirm: (question: string) => Promise<boolean>;
  /** Walk the mount into a ScannedFile list (overridable in tests). */
  scan: (mount: string) => Promise<ScannedFile[]>;
  /** Resolve a record's sha256 (overridable in tests). */
  hashOf: HashResolver;
  /**
   * Build the host-apply SafeExec for `--apply`. Lazily constructed so the
   * dry-run path NEVER touches the agent. In tests this is a spy whose call is
   * asserted to happen only after confirmation, never in dry-run.
   */
  makeExec: (opts: DiskImportOptions) => SafeExec;
  /**
   * Immich config for the photo upload pass. Optional — this CLI doesn't wire
   * Immich credentials yet (that's the UI card, #1697), so when it's absent the
   * apply skips photos (with a warning) rather than failing. Returns `undefined`
   * to skip photos.
   */
  immich?: ImmichConfig;
}

/**
 * Run the pipeline: scan -> inventory -> classify -> dedup -> plan, print the
 * report, then stop at the review gate. In `apply` mode require confirmation,
 * then apply to the host. In `dry-run` mode touch NOTHING on the host.
 *
 * Returns the ApplyResult on an applied run, or `null` for a dry run / aborted
 * apply (so callers/tests can assert no host write happened).
 */
export async function runDiskImport(
  opts: DiskImportOptions,
  io: DiskImportIO,
): Promise<ApplyResult | null> {
  io.log(`Scanning ${opts.mount} …`);
  const files = await io.scan(opts.mount);
  io.log(`Found ${files.length} files.`);

  const records = buildInventory(files);
  // Surface unclassifiable residue (left for the review gate / LLM path #1695).
  const undecided = records.filter(r => classifyRecord(r) === null).length;

  // dry-run computes against an in-memory catalog so it can't touch the host
  // catalog; apply opens the real (resume) catalog.
  const catalog = new ImportCatalog(opts.catalog);
  let plan: ImportPlan;
  try {
    plan = buildPlan(records, io.hashOf, { catalog });
  } finally {
    if (opts.mode === 'dry-run') catalog.close();
  }

  for (const line of renderReport(plan)) io.log(line);
  if (undecided > 0) {
    io.log(`  ${undecided} files had no deterministic category (filed under documents; review with #1695).`);
  }

  if (opts.mode === 'dry-run') {
    io.log('');
    io.log('Dry run: nothing was written. Re-run with --apply to import.');
    return null;
  }

  // --- Review gate. The ONLY path past here performs host I/O. ---
  io.log('');
  const proceed = await io.confirm(
    `Apply this plan to the host (node "${opts.node}")? Files will be copied into ` +
      `file-share/data/ and photos uploaded to Immich. This is resumable.`,
  );
  if (!proceed) {
    catalog.close();
    throw new DiskImportError('Aborted at the review gate. Nothing was written.');
  }

  return applyApprovedPlan(plan, opts, io, catalog);
}

/**
 * Apply a plan the operator has confirmed. Drops photo items when Immich isn't
 * wired (this CLI has no credentials path yet), then runs the host-apply via the
 * SafeExec seam. Always closes the catalog.
 */
async function applyApprovedPlan(
  plan: ImportPlan,
  opts: DiskImportOptions,
  io: DiskImportIO,
  catalog: ImportCatalog,
): Promise<ApplyResult> {
  // Photos go to Immich, which this CLI doesn't yet wire credentials for. With
  // no immich config, drop photo items (with a warning) rather than letting
  // applyPlan throw on the first photo.
  let toApply = plan;
  if (!io.immich) {
    const photoCount = plan.items.filter(i => i.category === 'photos').length;
    if (photoCount > 0) {
      io.log(`Note: ${photoCount} photo(s) skipped — Immich upload isn't wired in the CLI yet (use the UI card, #1697).`);
      toApply = { items: plan.items.filter(i => i.category !== 'photos'), conflicts: plan.conflicts };
    }
  }

  const exec = io.makeExec(opts);
  io.log('Applying …');
  try {
    const result = await applyPlan(toApply, {
      exec,
      mountpoint: opts.mount,
      catalog,
      shareGid: opts.shareGid,
      hashOf: io.hashOf,
      immich: io.immich,
    });
    io.log(`Applied ${result.applied} file(s); ${result.items.length - result.applied} skipped.`);
    return result;
  } finally {
    catalog.close();
  }
}

/** Default (real) IO: walk the mount with fs, hash with crypto, host-apply via
 *  the agent's structured `safe_exec`. */
function realIO(rl: readline.Interface): DiskImportIO {
  return {
    log: message => console.log(message),
    confirm: async question => {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    },
    scan: mount => walkMount(mount),
    hashOf: hashFileContent,
    makeExec: opts => {
      // Lazily import the agent stack — only reached on --apply, never dry-run.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AgentExecutor } = require('../packages/backend/src/lib/agent/executor.js');
      const executor = new AgentExecutor(opts.node);
      return (argv: string[], options?: { timeoutMs?: number }) => executor.execSafe(argv, options ?? {});
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseDiskImportArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await runDiskImport(parsed, realIO(rl));
  } finally {
    rl.close();
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    if (error instanceof DiskImportError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
