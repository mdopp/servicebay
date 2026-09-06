/**
 * `AutoUpdate=` policy for the `.kube` units ServiceBay generates (#2861).
 *
 * Every generated `.kube` used to carry `AutoUpdate=registry` unconditionally.
 * Quadlet turns that into `io.containers.autoupdate=registry` on **every**
 * container of the pod, and `podman auto-update` then tries to ping the
 * registry named in the image reference. For a locally built image
 * (`localhost/asteroids-gemma:1`) that means `https://localhost/v2/`, where
 * nothing listens — so the check fails, and because `podman-auto-update`
 * aggregates its per-container errors into one exit status, the **whole
 * box-wide run** dies with 125. Twenty other pods that were checked in the
 * same run silently lose their update signal behind that exit code.
 *
 * So the mode is derived from the pod spec's own images instead:
 *
 * | pod images                | result                                        |
 * |---------------------------|-----------------------------------------------|
 * | all from a real registry  | `AutoUpdate=registry` — unchanged, byte-for-byte |
 * | all `localhost/…`         | `AutoUpdate=local`                            |
 * | mixed                     | no `[Kube]` `AutoUpdate=` line; per-container  |
 * |                           | `io.containers.autoupdate/<container>` annotations |
 *
 * A single `[Kube] AutoUpdate=` line cannot express a mix — it is one value
 * for the whole pod — so the mixed case moves the decision into the pod YAML,
 * where `podman kube play` reads the per-container annotation form.
 * `podman-auto-update(1)` documents exactly two keys, both in the workload's
 * `metadata.annotations`, both taking `registry` or `local`:
 *   - `io.containers.autoupdate`             — the whole pod
 *   - `io.containers.autoupdate/<container>` — one container
 * With no annotation at all the policy is `disabled`, so the mixed case names
 * EVERY container — including the registry-backed ones, which would otherwise
 * silently lose auto-update along with the dropped `[Kube]` line.
 *
 * Two deliberate limits:
 *   - **Only `AutoUpdate=registry` is ours to correct.** No line at all (the
 *     Services-panel auto-update toggle off), `local`, or `none` is an
 *     explicit operator choice and is left exactly as found.
 *   - **Only `spec.containers` counts.** `initContainers` are run-once and
 *     removed, so `podman auto-update` never acts on them; letting a
 *     registry-based init container force a whole localhost pod into
 *     `registry` mode would reintroduce the 125.
 *
 * Pure string transforms — no I/O, no parse/serialise round-trip — so the
 * pod YAML a template author wrote comes back unchanged apart from the
 * annotations actually inserted, and every kube-write path can share this
 * (same rationale as `./quadletDirectives`).
 */

/** One `spec.containers[]` entry: the container's name and its image ref. */
export interface PodContainerImage {
  name: string;
  image: string;
}

/** `AutoUpdate=` / `io.containers.autoupdate` mode for one container. */
type AutoUpdateMode = 'registry' | 'local';

/** The `[Kube]` `AutoUpdate=` directive, wherever it sits in the unit. */
const AUTO_UPDATE_LINE = /^[\t ]*AutoUpdate[\t ]*=[\t ]*([^\r\n]*)$/m;

/**
 * Is this image reference one podman resolves locally?
 *
 * Podman prefixes a locally built, unqualified image with `localhost/`, and
 * that prefix is exactly what makes `podman auto-update` try to reach a
 * registry called `localhost`. Bare names without a registry are NOT local —
 * podman resolves those through `unqualified-search-registries` (docker.io),
 * so they auto-update from a registry like any other.
 */
export function isLocalImage(image: string): boolean {
  return /^localhost\//i.test(image.trim());
}

/** Read a `name:`/`image:` scalar off one line of a container entry. */
function readContainerField(target: { name?: string; image?: string }, text: string): void {
  const m = /^(name|image):[\t ]*(.*)$/.exec(text);
  if (!m) return;
  let value = m[2].trim();
  if (/^['"]/.test(value)) {
    // Quoted scalar: take what is inside the quotes, drop any trailing comment.
    const quoted = /^(['"])([\s\S]*?)\1[\t ]*(?:#.*)?$/.exec(value);
    if (!quoted) return;
    value = quoted[2];
  } else {
    value = value.replace(/[\t ]+#.*$/, '').trim();
  }
  if (!value) return;
  if (m[1] === 'name') target.name = value;
  else target.image = value;
}

/**
 * Lift `spec.containers[].name` + `.image` out of a rendered pod manifest.
 *
 * Indentation-scanned rather than YAML-parsed, on purpose: the manifest must
 * come back out of this module byte-identical unless we deliberately edit it,
 * and a `js-yaml` round-trip reformats everything. The scan tolerates both
 * common sequence styles (item dash at the key's indent, or indented under
 * it) and skips `initContainers:` — the regex is anchored, so
 * `initContainers:` never matches `containers:`.
 *
 * Entries missing a name or an image are dropped; a caller that gets fewer
 * containers than the manifest has must not assume it saw them all, which is
 * why `applyAutoUpdatePolicy` treats "found none" as "change nothing".
 */
export function extractPodContainerImages(podYaml: string): PodContainerImage[] {
  const out: PodContainerImage[] = [];
  const containersKey = /^([\t ]*)containers:[\t ]*(?:#.*)?$/;
  const itemStart = /^([\t ]*)-([\t ]+)(\S[\s\S]*)$/;

  let blockIndent: number | null = null;
  let itemIndent: number | null = null;
  let fieldIndent = 0;
  let current: { name?: string; image?: string } | null = null;

  const flush = (): void => {
    if (current?.name && current.image) out.push({ name: current.name, image: current.image });
    current = null;
  };

  for (const line of podYaml.split('\n')) {
    if (!line.trim() || /^[\t ]*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;

    if (blockIndent === null) {
      const key = containersKey.exec(line);
      if (key) {
        blockIndent = key[1].length;
        itemIndent = null;
      }
      continue;
    }

    const item = itemStart.exec(line);
    const isItem = item !== null
      && (itemIndent === null ? item[1].length >= blockIndent : item[1].length === itemIndent);
    if (isItem && item) {
      flush();
      itemIndent = item[1].length;
      fieldIndent = item[1].length + 1 + item[2].length;
      current = {};
      readContainerField(current, item[3]);
      continue;
    }

    if (indent <= blockIndent) {
      // Left the containers block. The line that ended it may itself open the
      // next one (`initContainers:` first, then `containers:`).
      flush();
      const key = containersKey.exec(line);
      blockIndent = key ? key[1].length : null;
      itemIndent = null;
      continue;
    }

    if (current && indent === fieldIndent) readContainerField(current, line.trim());
  }
  flush();
  return out;
}

/** Split a manifest into docs and separators, so a rejoin is lossless. */
function splitYamlDocs(podYaml: string): string[] {
  return podYaml.split(/^(---[\t ]*(?:#.*)?)$/m);
}

/**
 * Insert per-container auto-update annotations into the Pod doc's
 * `metadata.annotations`, skipping any key already present (idempotent, so a
 * redeploy of an unchanged service produces an unchanged file).
 *
 * Returns `null` when there is no `metadata:` block to put them in — the
 * caller then falls back to a mode that cannot break the box-wide run.
 */
function insertPodAnnotations(
  doc: string,
  entries: ReadonlyArray<readonly [string, AutoUpdateMode]>,
): string | null {
  const lines = doc.split('\n');
  const metaIdx = lines.findIndex(l => /^metadata:[\t ]*$/.test(l));
  if (metaIdx === -1) return null;

  // Walk metadata's children, looking for an existing `annotations:` block.
  // The first non-blank child fixes the block's indent; `annotations:` counts
  // only at that depth (a nested `annotations:` key would not be metadata's).
  let childIndent: number | null = null;
  let annIdx = -1;
  let annIndent = 2;
  for (let i = metaIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (childIndent === null) childIndent = indent;
    const m = /^([\t ]*)annotations:[\t ]*$/.exec(line);
    if (m && m[1].length === childIndent) { annIdx = i; annIndent = m[1].length; break; }
  }

  if (annIdx === -1) {
    const keyIndent = childIndent ?? 2;
    const entryIndent = ' '.repeat(keyIndent + 2);
    const block = [
      `${' '.repeat(keyIndent)}annotations:`,
      ...entries.map(([k, v]) => `${entryIndent}${k}: "${v}"`),
    ];
    lines.splice(metaIdx + 1, 0, ...block);
    return lines.join('\n');
  }

  // Indent of the existing block's entries, so ours line up with them.
  let entryIndent = ' '.repeat(annIndent + 2);
  for (let i = annIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= annIndent) break;
    entryIndent = line.slice(0, indent);
    break;
  }

  // Anything already declaring the key wins — never write it twice.
  const blockEnd = (() => {
    for (let i = annIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= annIndent) return i;
    }
    return lines.length;
  })();
  const existing = lines.slice(annIdx + 1, blockEnd).join('\n');
  const fresh = entries.filter(([k]) => !new RegExp(
    `^[\\t ]*['"]?${k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]?[\\t ]*:`,
    'm',
  ).test(existing));
  if (fresh.length === 0) return doc;

  // Inserted at the top of the block: the last entry may be a block scalar
  // (`servicebay.healthcheck: |`) whose end is not worth locating.
  lines.splice(annIdx + 1, 0, ...fresh.map(([k, v]) => `${entryIndent}${k}: "${v}"`));
  return lines.join('\n');
}

/**
 * Derive the `.kube` unit's auto-update mode from the pod spec's images.
 *
 * Returns the (possibly rewritten) unit and pod manifest. A pod whose images
 * all come from a real registry — the overwhelmingly common case — comes back
 * byte-identical, so existing quadlets on the box do not churn.
 */
export function applyAutoUpdatePolicy(
  kubeContent: string,
  podYaml: string,
): { kubeContent: string; podYaml: string } {
  const declared = AUTO_UPDATE_LINE.exec(kubeContent);
  // Only ServiceBay's own generated default is ours to correct; an absent,
  // `local` or `none` directive is a deliberate operator choice.
  if (!declared || declared[1].trim().toLowerCase() !== 'registry') return { kubeContent, podYaml };

  const containers = extractPodContainerImages(podYaml);
  if (containers.length === 0) return { kubeContent, podYaml };

  const localCount = containers.filter(c => isLocalImage(c.image)).length;
  if (localCount === 0) return { kubeContent, podYaml };

  if (localCount === containers.length) {
    return {
      kubeContent: kubeContent.replace(AUTO_UPDATE_LINE, line => line.replace(/registry/i, 'local')),
      podYaml,
    };
  }

  // Mixed pod: the single `[Kube]` line cannot say "registry for this
  // container, local for that one", so drop it and annotate per container.
  const entries = containers.map(
    c => [`io.containers.autoupdate/${c.name}`, isLocalImage(c.image) ? 'local' : 'registry'] as const,
  );
  const docs = splitYamlDocs(podYaml);
  for (let i = 0; i < docs.length; i += 2) {
    if (!/^[\t ]*kind:[\t ]*['"]?Pod['"]?[\t ]*$/m.test(docs[i])) continue;
    const annotated = insertPodAnnotations(docs[i], entries);
    if (annotated === null) break;
    docs[i] = annotated;
    return {
      kubeContent: kubeContent.replace(/^[\t ]*AutoUpdate[\t ]*=[\t ]*registry[\t ]*\r?\n?/m, ''),
      podYaml: docs.join(''),
    };
  }

  // No place to put the annotations. Fall back to `local`: one pod that stops
  // pulling registry updates is a far smaller problem than a box-wide
  // `podman auto-update` that exits 125 and takes every other pod with it.
  return {
    kubeContent: kubeContent.replace(AUTO_UPDATE_LINE, line => line.replace(/registry/i, 'local')),
    podYaml,
  };
}
