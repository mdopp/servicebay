/**
 * Extract `metadata.annotations['servicebay.tier']` from a template's
 * raw YAML content. Thin wrapper over the unified parser in
 * `src/lib/template/contract.ts` (#585).
 *
 * Two tiers, per the design conversation in #249:
 *   - `infrastructure` — auto-included by the install wizard,
 *     locked-checked (`adguard`, `nginx`, `auth`).
 *   - `feature` — user-pickable in the wizard's checkbox grid.
 *     Default when the annotation is missing OR the manifest doesn't
 *     parse — so a malformed template still shows up as user-pickable
 *     instead of mysteriously vanishing from the wizard.
 *
 * Note: a separate, pre-existing `servicebay.role` label on each
 * template (`reverse-proxy`, `system`, `dns`, ...) is **distinct**
 * from this tier classification — the label is consumed by service-
 * detection code paths for visual grouping, not by the install wizard.
 */

import { readManifestAnnotations, type TemplateTier } from './template/contract';

export type { TemplateTier };

export function parseTemplateTier(yamlText: string): TemplateTier {
  return readManifestAnnotations(yamlText).tier ?? 'feature';
}

/** True iff the tier marks the template as platform-tier (always installed). */
export function isInfrastructureTier(tier: TemplateTier): boolean {
  return tier === 'infrastructure';
}
