/**
 * Extract `metadata.annotations['servicebay.label']` from a template's
 * raw YAML content. Pure function with no Node dependencies — safe to
 * import from client components.
 *
 * Why a regex instead of a YAML parser: this runs in the wizard /
 * installer modal at variable-collection time, before the YAML is
 * known to be parseable (the user's variables haven't been substituted
 * yet, and our YAMLs contain `{{MUSTACHE}}` placeholders that valid
 * YAML happens to accept as bare strings — but we don't want to
 * couple to that). The annotation value itself is always a literal
 * string in our templates (the consistency test enforces it), so a
 * targeted regex is sufficient and avoids pulling js-yaml into the
 * earliest render path.
 */
export function parseTemplateLabel(yamlText: string): string | undefined {
  // Match `servicebay.label: "..."`, `servicebay.label: '...'`,
  // or `servicebay.label: bare value` (until end of line). Anchored to
  // an annotation-style indented line (any leading whitespace) so we
  // don't match references inside multi-line strings or comments.
  const re = /^\s+servicebay\.label:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]+?))\s*$/m;
  const m = re.exec(yamlText);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || undefined;
}
