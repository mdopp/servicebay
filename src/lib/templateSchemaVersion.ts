/**
 * Extract `metadata.annotations['servicebay.schema-version']` from a
 * template's raw YAML content. Thin wrapper over the unified parser in
 * `src/lib/template/contract.ts` (#585).
 *
 * The schema version bumps when a template's pod structure or variable
 * shape changes in a way that needs operator awareness (containers
 * split out, variables renamed, data paths moved). Plain image tag
 * updates DO NOT need a schema bump — those are handled by Quadlet's
 * AutoUpdate=registry transparently.
 *
 * Default is `1` when the annotation is missing OR the manifest doesn't
 * parse — covers existing templates whose authors haven't started
 * versioning yet, and keeps a malformed template usable rather than
 * crashing the upgrade flow. The strict parser surfaces the precise
 * error message via `parseTemplateManifest` directly; use that path in
 * code that should fail loudly (registry sync, consistency tests).
 *
 * See #353 / #352 (template upgrade system, phase 1).
 */

import { readManifestAnnotations } from './template/contract';

export function parseTemplateSchemaVersion(yamlText: string): number {
  return readManifestAnnotations(yamlText).schemaVersion ?? 1;
}
