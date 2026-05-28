/**
 * Install-time dependency parsing + topological ordering.
 *
 * Templates declare dependencies via a single annotation on the
 * pod-level metadata in `template.yml`:
 *
 *     metadata:
 *       annotations:
 *         servicebay.dependencies: "auth,nginx"
 *
 * Comma-separated list, no surrounding whitespace required. Empty
 * value or missing annotation = no install-time deps. The
 * install loop reads this once per template (via the rendered
 * yaml already loaded in startConfigure) and uses the topological
 * sort below to reorder the selected set so deps install first.
 *
 * Two failure modes the caller surfaces to the operator:
 * - `missing` — a selected template depends on something the
 *   operator didn't check. We don't silently auto-add: the user
 *   already saw the catalog and decided, so a clear "Foo requires
 *   Bar — go back and check Bar" message lets them recover.
 * - `cycle` — should never happen if templates are well-formed,
 *   but defensive: a cycle would otherwise loop the install.
 */

import { readManifestAnnotations } from '../template/contract';
import type { TemplateTier } from '../templateTier';

/** Parse `servicebay.dependencies` from a rendered template.yml.
 *  Returns the list of dep template names, trimmed, or an empty array
 *  when the annotation is missing/blank. Thin wrapper over the unified
 *  parser in `template/contract.ts` (#585) — callers that need strict
 *  error reporting should call `parseTemplateManifest` directly. */
export function parseTemplateDependencies(yaml: string | undefined): string[] {
  if (!yaml) return [];
  return readManifestAnnotations(yaml).dependencies ?? [];
}

export interface DependencyAwareItem {
  name: string;
  /** Names this item depends on. Resolved against the candidate set. */
  dependencies: string[];
  /** Install-tier classification — `infrastructure` items get an
   *  implicit edge from every `feature` item so the entire infra
   *  block lands before any feature deploy starts. Without this
   *  gate, a feature can register itself against an infrastructure
   *  service (NPM, Authelia) that isn't fully verified yet — and any
   *  late repair to the infra (NPM credentials self-heal, LLDAP
   *  re-seed) loses every prior registration. See #796. Default
   *  when omitted: `feature`. */
  tier?: TemplateTier;
}

export type TopoSortResult<T> =
  | { ok: true; ordered: T[] }
  | { ok: false; reason: 'missing'; item: string; missing: string[] }
  | { ok: false; reason: 'cycle'; involved: string[] };

/**
 * Compute the effective dependency edges used by the topological sort:
 * - each item's declared `servicebay.dependencies` that are in the set
 * - PLUS implicit "every feature depends on every infra in this set" so
 *   the order surfaces all infrastructure before any feature. Without
 *   this, an unrelated feature (`ollama`, `hermes`) that declares no deps
 *   can sneak in front of nginx/auth and register subdomain proxy hosts
 *   against NPM data the install runner is about to wipe and recreate
 *   (#796).
 */
function computeEffectiveDeps<T extends DependencyAwareItem>(
  items: T[],
  namesInSet: Set<string>,
): Map<string, string[]> {
  const infraNames = items
    .filter(it => it.tier === 'infrastructure')
    .map(it => it.name);
  const effectiveDeps = new Map<string, string[]>();
  for (const it of items) {
    const tier = it.tier ?? 'feature';
    const explicit = it.dependencies.filter(d => namesInSet.has(d));
    if (tier === 'infrastructure') {
      effectiveDeps.set(it.name, explicit);
    } else {
      const implicit = infraNames.filter(n => n !== it.name);
      effectiveDeps.set(it.name, [...new Set([...explicit, ...implicit])]);
    }
  }
  return effectiveDeps;
}

/**
 * Build the set of dependency-satisfying names for an install: everything
 * already deployed on the target node, plus anything the operator flagged as
 * already-installed in this batch. Pass the result as `topoSortByDependencies`'
 * `alreadyInstalled`. Without the node set, a dependency on something that's
 * installed but not re-selected (e.g. `hermes` → `home-assistant`) is wrongly
 * reported missing just because it wasn't in the current selection.
 */
export function resolveAlreadyInstalled(
  batchItems: ReadonlyArray<{ name: string; alreadyInstalled?: boolean }>,
  deployedOnNode: Iterable<string>,
): Set<string> {
  const set = new Set<string>(deployedOnNode);
  for (const item of batchItems) {
    if (item.alreadyInstalled) set.add(item.name);
  }
  return set;
}

/**
 * Topologically sort `items` so every entry's dependencies appear
 * earlier in the result. Items whose dependencies aren't in
 * `candidates` (typically `selectedNames`) return `missing`; cycles
 * return `cycle`. Stable: keeps the input order among items that have
 * the same dependency depth so the operator sees a predictable
 * sequence in the wizard log.
 *
 * `extra` is used to keep `alreadyInstalled` items as satisfiers
 * without including them in the output — i.e. if the operator
 * already installed `auth` in a previous run and is now adding
 * `vaultwarden`, the dep on `auth` is considered satisfied.
 */
export function topoSortByDependencies<T extends DependencyAwareItem>(
  items: T[],
  opts: { alreadyInstalled?: ReadonlySet<string> } = {},
): TopoSortResult<T> {
  const alreadyInstalled = opts.alreadyInstalled ?? new Set<string>();
  const namesInSet = new Set(items.map(i => i.name));

  // Check 1: every dep is either in the set or already-installed.
  for (const item of items) {
    const missing = item.dependencies.filter(
      d => !namesInSet.has(d) && !alreadyInstalled.has(d),
    );
    if (missing.length > 0) {
      return { ok: false, reason: 'missing', item: item.name, missing };
    }
  }

  const effectiveDeps = computeEffectiveDeps(items, namesInSet);

  // Kahn's algorithm with a stable tiebreaker (input order).
  const indeg = new Map<string, number>();
  const byName = new Map<string, T>();
  const inputOrder = new Map<string, number>();
  items.forEach((it, i) => {
    byName.set(it.name, it);
    inputOrder.set(it.name, i);
    indeg.set(it.name, (effectiveDeps.get(it.name) ?? []).length);
  });

  const ready: T[] = items.filter(it => (indeg.get(it.name) ?? 0) === 0);
  const ordered: T[] = [];

  while (ready.length > 0) {
    // Stable tiebreaker — sort ready items by input order so the
    // result is deterministic regardless of Map iteration quirks.
    ready.sort((a, b) => (inputOrder.get(a.name) ?? 0) - (inputOrder.get(b.name) ?? 0));
    const next = ready.shift()!;
    ordered.push(next);
    for (const other of items) {
      if ((effectiveDeps.get(other.name) ?? []).includes(next.name)) {
        const newDeg = (indeg.get(other.name) ?? 0) - 1;
        indeg.set(other.name, newDeg);
        if (newDeg === 0 && !ordered.includes(other) && !ready.includes(other)) {
          ready.push(other);
        }
      }
    }
  }

  if (ordered.length !== items.length) {
    const involved = items.filter(it => !ordered.includes(it)).map(it => it.name);
    return { ok: false, reason: 'cycle', involved };
  }
  return { ok: true, ordered };
}
