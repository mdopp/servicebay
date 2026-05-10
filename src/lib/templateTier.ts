/**
 * Extract `metadata.annotations['servicebay.tier']` from a template's
 * raw YAML content. Mirrors `parseTemplateLabel` in shape so it can be
 * imported from client components without dragging Node deps.
 *
 * Two tiers, per the design conversation in #249:
 *
 *   - **`infrastructure`** — auto-included by the install wizard,
 *     locked-checked. The platform layer every install carries
 *     (currently `adguard`, `nginx`, `auth`).
 *   - **`feature`** — user-pickable in the wizard's checkbox grid.
 *     Default when the annotation is missing or unrecognized.
 *
 * Note: a separate, pre-existing `servicebay.role` label on each
 * template (`reverse-proxy`, `system`, `dns`, ...) is **distinct**
 * from this tier classification — the label is consumed by service-
 * detection code paths (network/service.ts, ServicesPlugin) for
 * visual grouping, not by the install wizard.
 */

/** Recognized template tiers. `feature` is the implicit default. */
export type TemplateTier = 'infrastructure' | 'feature';

const KNOWN_TIERS: ReadonlySet<string> = new Set(['infrastructure', 'feature']);

/**
 * Pull the tier annotation from a template.yml string. Returns
 * `'feature'` when the annotation is missing or unrecognized — that
 * way new templates default to user-pickable without ceremony.
 *
 * Intentionally regex-based for the same reason as parseTemplateLabel:
 * runs in client code before mustache substitution, so we don't want
 * to require the YAML to be parseable as-is.
 */
export function parseTemplateTier(yamlText: string): TemplateTier {
  const re = /^\s+servicebay\.tier:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]+?))\s*$/m;
  const m = re.exec(yamlText);
  const raw = (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').trim();
  if (raw && KNOWN_TIERS.has(raw)) {
    return raw as TemplateTier;
  }
  return 'feature';
}

/** True iff the tier marks the template as platform-tier (always installed). */
export function isInfrastructureTier(tier: TemplateTier): boolean {
  return tier === 'infrastructure';
}
