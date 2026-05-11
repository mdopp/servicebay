/**
 * Extract `metadata.annotations['servicebay.schema-version']` from a
 * template's raw YAML content. Mirrors `parseTemplateTier` in shape.
 *
 * The schema version bumps when a template's pod structure or variable
 * shape changes in a way that needs operator awareness (containers
 * split out, variables renamed, data paths moved). Plain image tag
 * updates DO NOT need a schema bump — those are handled by Quadlet's
 * AutoUpdate=registry transparently.
 *
 * Default is `1` when the annotation is missing — covers existing
 * templates whose authors haven't started versioning yet. The
 * comparison logic in the update flow treats "from missing/v1 to vN"
 * the same as "from v1 to vN".
 *
 * Intentionally regex-based: runs before mustache substitution, so we
 * don't want to require the YAML to be parseable as-is.
 *
 * See #353 / #352 (template upgrade system, phase 1).
 */
export function parseTemplateSchemaVersion(yamlText: string): number {
  const re = /^\s+servicebay\.schema-version:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]+?))\s*$/m;
  const m = re.exec(yamlText);
  const raw = (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').trim();
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}
