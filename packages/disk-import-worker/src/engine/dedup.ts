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
import { DEFAULT_AREA, type ImportCatalog } from './catalog';
import { destinationArea, dirOfRel, effectiveRule, resolveTargetPath } from './routing';
import type {
  Category,
  Conflict,
  ImportAction,
  ImportPlan,
  ImportPlanItem,
  ImportRecord,
  Rule,
} from './types';

/** Resolves a record's content hash (sha256 hex). Called only when needed. */
export type HashResolver = (record: ImportRecord) => string;

export interface PlanOptions {
  /**
   * Cheap content FINGERPRINT resolver (e.g. sha256 of the first+last 64KB +
   * size) used to dedup same-size files WITHOUT reading them whole. Only when
   * two files also share a fingerprint do we fall back to the full `hashOf` to
   * confirm they're truly identical (avoids a false "duplicate" → never drops a
   * file). On a backup disk full of same-size files this turns hours of full
   * reads into a few MB. Defaults to `hashOf` when omitted (correct, just not
   * faster). (#1995)
   */
  fingerprintOf?: HashResolver;
  /**
   * Progress callback fired while fingerprinting the size-colliding files (the
   * only expensive, I/O-bound part of planning a large disk). Lets the worker
   * write live progress so a long plan never looks hung. (#1995)
   */
  onProgress?: (done: number, total: number) => void;
  /** Per-record classification hints (keyed by source path). */
  hints?: Record<string, ClassifyHints>;
  /** Optional LLM-residue classifier seam (#1695); never invoked here itself. */
  residue?: ResidueClassifier;
  /** Existing catalog for cross-run (delta) dedup. Optional. */
  catalog?: ImportCatalog;
  /**
   * Resolves a record's DESTINATION AREA (owner-derived, #1912) — the dedup
   * scope. A private area (`<userId>`) dedups within itself; `shared` merges
   * across users. Defaults every record to `'shared'` when omitted, preserving
   * the pre-#1912 single-area behaviour. Owner/area resolution itself lives in
   * routing.ts; the caller threads `effectiveRule(...).owner → destinationArea`
   * through here. The catalog/in-tree dedup key is (area, target).
   */
  areaOf?: (record: ImportRecord) => string;
  /**
   * The per-folder routing tree (issue #1915). When present it OVERRIDES the
   * flat `targetFor` / default `areaOf`: every record is routed by its folder's
   * `effectiveRule` (owner + mode + forced-disposition), so the target becomes
   * `<owner?>/<category>/…` (see `resolveTargetPath`) and the dedup area follows
   * the resolved owner. Built once (with the auto-assigned + user-edited rule
   * map and the disk-default owner) by the service and threaded through here.
   * Omit it for the pre-#1915 flat behaviour.
   */
  routing?: RoutingResolution;
  /** Clock for deterministic tests. */
  now?: () => number;
}

/**
 * Resolves a record's routing coordinates from the per-folder tree (#1915):
 * its path RELATIVE to the disk root and the directory that owns it. The service
 * supplies this (it holds the mountpoint to strip + the explicit rule map);
 * `buildPlan` uses it to derive owner-aware targets + dedup areas + the folder's
 * forced disposition.
 */
export interface RoutingResolution {
  /** The file's path relative to the disk root (the routing tree coordinate). */
  relPathOf: (record: ImportRecord) => string;
  /** The explicit (auto-assigned + edited) rule map, keyed by relative dir. */
  explicit: ReadonlyMap<string, Rule>;
  /** The root default (e.g. the disk-default owner). */
  rootDefault: Partial<Rule>;
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
  opts: Pick<PlanOptions, 'hints' | 'residue' | 'routing'>,
  junkItems: ImportPlanItem[],
): Classified[] {
  const { hints = {}, residue, routing } = opts;
  const keep: Classified[] = [];
  for (const record of records) {
    // With a routing tree, the folder's effective rule supplies the forced
    // disposition (overrides the content classifier) and the owner/mode-aware
    // target. A `skip` disposition routes the file to junk (not imported).
    const rule = routing
      ? effectiveRule(dirOfRel(routing.relPathOf(record)), routing.explicit, routing.rootDefault)
      : undefined;
    if (rule?.disposition === 'skip') {
      junkItems.push({ record, category: 'junk', target: null, action: 'skip-junk' });
      continue;
    }
    const category =
      classifyRecord(record, hints[record.sourcePath], residue, rule?.disposition) ?? 'documents';
    const target = routing
      ? resolveTargetPath(routing.relPathOf(record), category, rule!)
      : targetFor(record, category);
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
  const { catalog, routing } = opts;
  // The dedup area follows the resolved owner when a routing tree is present
  // (a private area dedups within itself); else the explicit areaOf, else shared.
  const areaOf =
    opts.areaOf ??
    (routing
      ? (record: ImportRecord) =>
          destinationArea(
            effectiveRule(dirOfRel(routing.relPathOf(record)), routing.explicit, routing.rootDefault)
              .owner,
          )
      : () => DEFAULT_AREA);
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

  // Stable (sourcePath) iteration order so the first file at a target wins.
  const ordered = keep
    .slice()
    .sort((a, b) =>
      a.record.sourcePath < b.record.sourcePath ? -1 : a.record.sourcePath > b.record.sourcePath ? 1 : 0,
    );

  // Two-tier content keys: cheap fingerprint first, full hash only on a
  // fingerprint collision or a cataloged target (#1995).
  const keys = resolveContentKeys(ordered, bySize, {
    hashOf,
    fingerprintOf: opts.fingerprintOf ?? hashOf,
    catalog,
    areaOf,
    onProgress: opts.onProgress,
  });

  // Track, within this tree, the content hash already claiming each destination
  // slot. The slot key is (area, target): the SAME target in two areas (e.g.
  // `shared` vs a user area) is two distinct slots — private dedups within
  // itself, `shared` merges across sources.
  const targetOwner = new Map<string, { key: string; sha256?: string; sourcePath: string }>();
  // Per-original-slot probe cursor for disambiguating renames (#2006), so N
  // distinct files at one name resolve to (2),(3)… in O(N) not O(N²).
  const renameCounters = new Map<string, number>();

  // 3. Decide each kept record from its precomputed content key.
  for (const c of ordered) {
    const target = c.target!;
    const area = areaOf(c.record);
    const slot = dedupSlot(area, target);
    const decision = decide(c, target, area, slot, keys.get(c.record.sourcePath)!, {
      targetOwner,
      renameCounters,
      catalog,
      conflicts,
    });
    items.push({
      record: c.record,
      category: c.category,
      target: decision.target,
      action: decision.action,
      ...(decision.renamed ? { renamed: true } : {}),
    });
  }

  // Stable output ordering.
  items.sort((a, b) =>
    a.record.sourcePath < b.record.sourcePath ? -1 : a.record.sourcePath > b.record.sourcePath ? 1 : 0,
  );

  return { items, conflicts };
}

/** The composite dedup-slot key: a target is deduped WITHIN its destination area. */
function dedupSlot(area: string, target: string): string {
  return `${area} ${target}`;
}

/**
 * A record's comparable content identity. `key` is what dedup compares (equal
 * keys mean same content); `sha256` is the FULL hash, present only when the
 * record was fully hashed (needed for catalog comparison, which stores full
 * hashes).
 */
interface KeyInfo {
  key: string;
  sha256?: string;
}

/**
 * Fingerprint-trust dedup keying (#1995). Reads as little as possible:
 *  - size-unique files are NEVER read (`u:` key, can't duplicate anything);
 *  - size-colliding files are deduped by a cheap FINGERPRINT (`f:` key, sha256 of
 *    size + head/middle/tail 64KB) — equal fingerprint ⇒ treated as the same
 *    content. A full read is NOT used to confirm: on a backup disk almost every
 *    same-size file is a true duplicate, so confirming by full hash means reading
 *    hundreds of GB (the original bug, just moved later). A head+middle+tail+size
 *    match between two genuinely different files is astronomically unlikely, and
 *    the import is copy-only over a READ-ONLY source — so the worst case of a
 *    false match is one file not COPIED (still safe on the disk), never data loss.
 *  - the ONLY full hash is for a record whose target is already in the catalog
 *    (a delta/re-run), because the catalog stores full sha256 (`h:` key). A first
 *    import has an empty catalog, so it does ZERO full reads.
 * Progress is reported across the fingerprint pass (the dominant I/O) so a large
 * plan shows live progress and never looks hung.
 */
function resolveContentKeys(
  ordered: Classified[],
  bySize: Map<number, Classified[]>,
  opts: {
    hashOf: HashResolver;
    fingerprintOf: HashResolver;
    catalog?: ImportCatalog;
    areaOf: (record: ImportRecord) => string;
    onProgress?: (done: number, total: number) => void;
  },
): Map<string, KeyInfo> {
  const { hashOf, fingerprintOf, catalog, areaOf, onProgress } = opts;

  // Records whose target is already cataloged need a FULL hash to compare with
  // the catalog (it stores full sha256). Empty on a first import.
  const needsFullForCatalog = (c: Classified): boolean =>
    catalog?.getByTarget(c.target!, areaOf(c.record)) !== undefined;

  // The work to report progress over: every size-colliding file is fingerprinted,
  // plus any cataloged-target file is full-hashed.
  const reads = ordered.filter(
    c => (bySize.get(c.record.size)?.length ?? 0) > 1 || needsFullForCatalog(c),
  );
  const total = reads.length;
  let done = 0;
  const tick = (): void => {
    done += 1;
    if (onProgress && (done % 1000 === 0 || done === total)) onProgress(done, total);
  };

  const out = new Map<string, KeyInfo>();
  for (const c of ordered) {
    const sizeCollides = (bySize.get(c.record.size)?.length ?? 0) > 1;
    if (needsFullForCatalog(c)) {
      const sha = c.record.sha256 ?? hashOf(c.record);
      out.set(c.record.sourcePath, { key: `h:${sha}`, sha256: sha });
      tick();
    } else if (sizeCollides) {
      const fp = c.record.sha256 ?? fingerprintOf(c.record);
      out.set(c.record.sourcePath, { key: `f:${fp}` });
      tick();
    } else {
      out.set(c.record.sourcePath, { key: `u:${c.record.sourcePath}` });
    }
  }
  return out;
}

/** A decided record: its (possibly disambiguated) target, the action, and whether the name was changed. */
interface Decision {
  action: ImportAction;
  target: string;
  renamed?: boolean;
}

function decide(
  c: Classified,
  target: string,
  area: string,
  slot: string,
  info: KeyInfo,
  ctx: {
    targetOwner: Map<string, { key: string; sha256?: string; sourcePath: string }>;
    renameCounters: Map<string, number>;
    catalog?: ImportCatalog;
    conflicts: Conflict[];
  },
): Decision {
  const { key, sha256 } = info;

  // Catalog dedup compares FULL hashes (the catalog stores full sha256). sha256
  // is present exactly when this record was fully hashed, which resolveContentKeys
  // guarantees whenever the target is already cataloged. This is the cross-run
  // newer-wins path (apply routes the existing file to _superseded) — left as a
  // conflict on purpose; #2006 only changes the in-tree distinct-name case below.
  if (sha256 !== undefined) {
    if (ctx.catalog?.has(sha256, target, area)) return { action: 'skip-dupe', target };
    const catHit = ctx.catalog?.getByTarget(target, area);
    if (catHit && catHit.sha256 !== sha256) {
      ctx.conflicts.push({
        target,
        existing: { sourcePath: catHit.sourcePath, sha256: catHit.sha256 },
        incoming: { sourcePath: c.record.sourcePath, sha256 },
      });
      return { action: 'conflict', target };
    }
  }

  // In-tree collision at this slot (same area + target)? Compare by content key.
  const owner = ctx.targetOwner.get(slot);
  if (owner) {
    if (owner.key === key) return { action: 'skip-dupe', target }; // same content, different path
    // DISTINCT files clashing on one name are NOT the same photo/doc — import the
    // later one under a disambiguated name (`IMG_0001 (2).jpg`) instead of dropping
    // it as an unresolved conflict (#2006, DATA SAFETY). Deterministic: stable
    // sourcePath order + a per-original-slot probe cursor make re-runs reproduce
    // the same names; a 3rd distinct clash → `(3)`, etc.
    const renamedTarget = uniquifyTarget(target, area, slot, ctx);
    ctx.targetOwner.set(dedupSlot(area, renamedTarget), { key, sha256, sourcePath: c.record.sourcePath });
    return { action: 'copy', target: renamedTarget, renamed: true };
  }

  // First file to claim this slot.
  ctx.targetOwner.set(slot, { key, sha256, sourcePath: c.record.sourcePath });
  return { action: 'copy', target };
}

/**
 * Split a target path into directory, stem and extension so a disambiguating
 * suffix lands BEFORE the extension (`photos/IMG_0001.jpg` → `photos/IMG_0001 (2).jpg`).
 * A leading dot (dotfile, e.g. `.bashrc`) is treated as no extension.
 */
function splitTarget(target: string): { dir: string; stem: string; ext: string } {
  const slash = target.lastIndexOf('/');
  const dir = slash >= 0 ? target.slice(0, slash + 1) : '';
  const base = target.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot > 0) return { dir, stem: base.slice(0, dot), ext: base.slice(dot) };
  return { dir, stem: base, ext: '' };
}

/**
 * Find a free disambiguated target for a name already claimed by different
 * content (#2006). Probes `<stem> (2)<ext>`, `(3)`… within the same area, skipping
 * any slot already claimed (including a real source file that genuinely has that
 * name). `renameCounters` (keyed by the ORIGINAL slot) remembers where the last
 * probe stopped so M clashes on one name cost O(M), not O(M²). Returns the new
 * target relative path; the caller claims its slot.
 */
function uniquifyTarget(
  target: string,
  area: string,
  originalSlot: string,
  ctx: { targetOwner: Map<string, unknown>; renameCounters: Map<string, number> },
): string {
  const { dir, stem, ext } = splitTarget(target);
  let n = ctx.renameCounters.get(originalSlot) ?? 2;
  for (;;) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    n += 1;
    if (!ctx.targetOwner.has(dedupSlot(area, candidate))) {
      ctx.renameCounters.set(originalSlot, n);
      return candidate;
    }
  }
}
