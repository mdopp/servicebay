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

/** Single regex per yaml — matches `servicebay.dependencies: "..."`,
 *  `'...'`, or unquoted, anywhere in the file. Indentation isn't
 *  validated because the templates already pass yaml-syntax tests
 *  (template_consistency.test.ts); this regex just needs the value. */
const DEPS_ANNOTATION_RE =
  /^\s+servicebay\.dependencies:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]+?))\s*$/m;

/** Parse `servicebay.dependencies` from a rendered template.yml.
 *  Returns the list of dep template names, lowercase-trimmed, or
 *  an empty array when the annotation is missing/blank. */
export function parseTemplateDependencies(yaml: string | undefined): string[] {
  if (!yaml) return [];
  const m = DEPS_ANNOTATION_RE.exec(yaml);
  if (!m) return [];
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export interface DependencyAwareItem {
  name: string;
  /** Names this item depends on. Resolved against the candidate set. */
  dependencies: string[];
}

export type TopoSortResult<T> =
  | { ok: true; ordered: T[] }
  | { ok: false; reason: 'missing'; item: string; missing: string[] }
  | { ok: false; reason: 'cycle'; involved: string[] };

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

  // Kahn's algorithm with a stable tiebreaker (input order).
  const indeg = new Map<string, number>();
  const byName = new Map<string, T>();
  const inputOrder = new Map<string, number>();
  items.forEach((it, i) => {
    byName.set(it.name, it);
    inputOrder.set(it.name, i);
    indeg.set(it.name, it.dependencies.filter(d => namesInSet.has(d)).length);
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
      if (other.dependencies.includes(next.name)) {
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
