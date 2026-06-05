// Disk-import engine — dedup + planning (issue #1693).
//
// Builds the final ImportPlan from classified records. Dedup is size→hash:
// content is hashed ONLY when two files share a size (in-tree) or a target path
// is already cataloged — so a unique-sized file is never hashed. Same content
// already at the same target → skip-dupe. Different content competing for the
// same target → conflict.
//
// This module performs NO content reads itself: the hash is supplied by an
// injected `hashOf` resolver (the host-side caller hashes the bytes; tests pass
// a fixture map). Junk is skipped. Everything is deterministic.

import { CATEGORIES } from './categories';
import { classifyRecord, type ClassifyHints, type ResidueClassifier } from './classify';
import { baseName } from './inventory';
import type { ImportCatalog } from './catalog';
import type {
  Category,
  Conflict,
  ImportAction,
  ImportPlan,
  ImportPlanItem,
  ImportRecord,
} from './types';

/** Resolves a record's content hash (sha256 hex). Called only when needed. */
export type HashResolver = (record: ImportRecord) => string;

export interface PlanOptions {
  /** Per-record classification hints (keyed by source path). */
  hints?: Record<string, ClassifyHints>;
  /** Optional LLM-residue classifier seam (#1695); never invoked here itself. */
  residue?: ResidueClassifier;
  /** Existing catalog for cross-run (delta) dedup. Optional. */
  catalog?: ImportCatalog;
  /** Clock for deterministic tests. */
  now?: () => number;
}

/**
 * Map a record to its target path under `file-share/data/`, relative to that
 * root (e.g. `photos/IMG_0001.jpg`). The file name is preserved; topic
 * sub-foldering for documents is a later (LLM) concern. `junk` → `null`.
 */
export function targetFor(record: ImportRecord, category: Category): string | null {
  if (category === 'junk') return null;
  return CATEGORIES[category].folder + baseName(record.sourcePath);
}

interface Classified {
  record: ImportRecord;
  category: Category;
  target: string | null;
}

/**
 * Classify every record and split junk (emitted as skip-junk) from the records
 * that need dedup. A `null`/undecidable classification falls back to `documents`
 * — the catch-all bucket — rather than dropping the file silently.
 */
function classifyAndSplit(
  records: ImportRecord[],
  opts: Pick<PlanOptions, 'hints' | 'residue'>,
  junkItems: ImportPlanItem[],
): Classified[] {
  const { hints = {}, residue } = opts;
  const keep: Classified[] = [];
  for (const record of records) {
    const category = classifyRecord(record, hints[record.sourcePath], residue) ?? 'documents';
    const target = targetFor(record, category);
    if (category === 'junk' || target === null) {
      junkItems.push({ record, category: 'junk', target: null, action: 'skip-junk' });
    } else {
      keep.push({ record, category, target });
    }
  }
  return keep;
}

/**
 * Build the deterministic import plan from a record inventory.
 *
 * Algorithm:
 *  1. Classify every record (junk skipped, no target).
 *  2. Group the non-junk records by size — a size with a single member can't be
 *     a duplicate, so it's never hashed.
 *  3. For multi-member sizes (and any record whose target is already cataloged),
 *     resolve the hash and decide: skip-dupe (same hash already at target, in
 *     this tree or the catalog) / conflict (different hash, same target) / copy.
 */
export function buildPlan(
  records: ImportRecord[],
  hashOf: HashResolver,
  opts: PlanOptions = {},
): ImportPlan {
  const { catalog } = opts;
  const items: ImportPlanItem[] = [];
  const conflicts: Conflict[] = [];

  // 1. Classify; junk is emitted as skip-junk, the rest kept for dedup.
  const keep = classifyAndSplit(records, opts, items);

  // 2. Group by size to decide what must be hashed.
  const bySize = new Map<number, Classified[]>();
  for (const c of keep) {
    const arr = bySize.get(c.record.size);
    if (arr) arr.push(c);
    else bySize.set(c.record.size, [c]);
  }

  // Hash a record at most once.
  const hashCache = new Map<string, string>();
  const hashFor = (record: ImportRecord): string => {
    if (record.sha256) return record.sha256;
    const cached = hashCache.get(record.sourcePath);
    if (cached) return cached;
    const h = hashOf(record);
    hashCache.set(record.sourcePath, h);
    return h;
  };

  // Track, within this tree, the content hash already claiming each target.
  const targetOwner = new Map<string, { sha256: string; sourcePath: string }>();

  // 3. Decide each kept record. Iterate in stable (sourcePath) order so the
  //    first file at a target is the deterministic winner.
  const ordered = keep
    .slice()
    .sort((a, b) =>
      a.record.sourcePath < b.record.sourcePath ? -1 : a.record.sourcePath > b.record.sourcePath ? 1 : 0,
    );

  for (const c of ordered) {
    const target = c.target!;
    const sizeGroup = bySize.get(c.record.size)!;
    const catHit = catalog?.getByTarget(target);
    // Hash only when this size collides in-tree, the target already has an
    // in-tree owner, or the catalog already holds this target.
    const mustHash = sizeGroup.length > 1 || targetOwner.has(target) || catHit !== undefined;
    const action = decide(c, target, mustHash ? hashFor : null, { targetOwner, catalog, conflicts });
    items.push({ record: c.record, category: c.category, target, action });
  }

  // Stable output ordering.
  items.sort((a, b) =>
    a.record.sourcePath < b.record.sourcePath ? -1 : a.record.sourcePath > b.record.sourcePath ? 1 : 0,
  );

  return { items, conflicts };
}

function decide(
  c: Classified,
  target: string,
  hashFor: HashResolver | null,
  ctx: {
    targetOwner: Map<string, { sha256: string; sourcePath: string }>;
    catalog?: ImportCatalog;
    conflicts: Conflict[];
  },
): ImportAction {
  // No hashing needed → unique file, plain copy, claim the target slot.
  if (!hashFor) {
    return 'copy';
  }

  const sha = hashFor(c.record);

  // Already imported this exact content to this exact target (delta run)?
  if (ctx.catalog?.has(sha, target)) return 'skip-dupe';

  // A different content already cataloged at this target → conflict.
  const catHit = ctx.catalog?.getByTarget(target);
  if (catHit && catHit.sha256 !== sha) {
    ctx.conflicts.push({
      target,
      existing: { sourcePath: catHit.sourcePath, sha256: catHit.sha256 },
      incoming: { sourcePath: c.record.sourcePath, sha256: sha },
    });
    return 'conflict';
  }

  // In-tree collision at this target?
  const owner = ctx.targetOwner.get(target);
  if (owner) {
    if (owner.sha256 === sha) return 'skip-dupe'; // same bytes, different path
    ctx.conflicts.push({
      target,
      existing: { sourcePath: owner.sourcePath, sha256: owner.sha256 },
      incoming: { sourcePath: c.record.sourcePath, sha256: sha },
    });
    return 'conflict';
  }

  // First copy to this target — claim it.
  ctx.targetOwner.set(target, { sha256: sha, sourcePath: c.record.sourcePath });
  return 'copy';
}
