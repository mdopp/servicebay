import type { StackVariable } from './postInstall';

export interface VariableGroup {
  /** Internal template key (e.g. "lldap") or "_global" / "_other". */
  key: string;
  /** User-facing display name. */
  label: string;
  /** Variables in this group, preserving the order they were declared. */
  variables: StackVariable[];
}

/**
 * Group variables by the template that originally declared them, so the
 * configure step can render service-by-service sections instead of a flat
 * list.
 *
 * - Variables marked `global: true` go into the special `_global` bucket,
 *   which the UI renders read-only at the top.
 * - Variables whose `meta.templateName` is set are grouped by that name;
 *   the section's display label comes from `meta.templateLabel` (read at
 *   collection time from the template.yml's
 *   `metadata.annotations['servicebay.label']`).
 * - Anything else (legacy templates without origin tagging) lands in
 *   `_other` so it stays visible to the user.
 *
 * Templates with no user-configurable variables (everything is `secret` /
 * `rsa-private` / `bcrypt`) are dropped — there is nothing to render.
 */
export function groupVariablesByTemplate(variables: StackVariable[]): VariableGroup[] {
  // Hide variables that are computed automatically and not meaningful to
  // edit by hand (multi-line PEMs, bcrypt hashes derived from another var).
  // `secret` types stay visible — the wizard renders them with an edit
  // input + a regenerate button so users can accept the auto-gen value or
  // override it with something memorable.
  const isHidden = (v: StackVariable) =>
    v.meta?.type === 'rsa-private' ||
    v.meta?.type === 'bcrypt';

  // Track the friendly label per group key, captured from the first
  // variable that declares one. Per group, every variable should agree
  // on the label since they share a templateName.
  const groups = new Map<string, StackVariable[]>();
  const labels = new Map<string, string>();
  for (const v of variables) {
    if (isHidden(v)) continue; // never displayed
    const key = v.global ? '_global' : (v.meta?.templateName || '_other');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
    if (v.meta?.templateLabel && !labels.has(key)) {
      labels.set(key, v.meta.templateLabel);
    }
  }

  // Stable ordering: globals first, then services in declaration order
  // (preserve the order Map.keys() provides), then '_other' last.
  const result: VariableGroup[] = [];
  if (groups.has('_global')) {
    result.push({ key: '_global', label: 'From Settings', variables: groups.get('_global')! });
    groups.delete('_global');
  }
  const otherEntry = groups.get('_other');
  groups.delete('_other');
  for (const [key, vars] of groups) {
    result.push({
      key,
      label: labels.get(key) || key,
      variables: vars,
    });
  }
  if (otherEntry && otherEntry.length > 0) {
    result.push({ key: '_other', label: 'Other', variables: otherEntry });
  }
  return result;
}
