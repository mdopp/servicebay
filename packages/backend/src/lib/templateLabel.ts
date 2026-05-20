/**
 * Extract `metadata.annotations['servicebay.label']` from a template's
 * raw YAML content. Thin wrapper over the unified parser in
 * `src/lib/template/contract.ts` (#585) — kept as a named export so the
 * existing call sites (wizard, installer modal, portal) don't all need
 * to change.
 *
 * Returns `undefined` when the annotation is missing or the manifest is
 * otherwise invalid; callers fall back to the raw template name in that
 * case. The strict parser surfaces the precise error message via
 * `parseTemplateManifest` directly — use that path in code that should
 * fail loudly (registry sync, consistency tests).
 */

import { readManifestAnnotations } from './template/contract';

export function parseTemplateLabel(yamlText: string): string | undefined {
  return readManifestAnnotations(yamlText).label;
}
