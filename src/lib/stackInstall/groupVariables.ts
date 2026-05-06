import type { StackVariable } from './postInstall';

/** Friendly display names for templates that show up grouped in the UI. */
const DISPLAY_NAMES: Record<string, string> = {
  'nginx-web': 'Nginx Proxy Manager',
  'lldap': 'LLDAP (User Directory)',
  'authelia': 'Authelia (SSO)',
  'adguard': 'AdGuard Home (DNS)',
  'vaultwarden': 'Vaultwarden (Passwords)',
  'immich': 'Immich (Photos)',
  'file-share': 'File Share (Syncthing + Samba)',
  'home-assistant-stack': 'Home Assistant Stack',
};

export interface VariableGroup {
  /** Internal template key (e.g. "lldap") or "_global" / "_shared". */
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
 * - Variables whose `meta.templateName` is set are grouped by that name.
 * - Anything else (legacy templates without origin tagging) lands in
 *   `_other` so it stays visible to the user.
 *
 * Templates with no user-configurable variables (everything is `secret` /
 * `rsa-private` / `bcrypt`) are dropped — there is nothing to render.
 */
export function groupVariablesByTemplate(variables: StackVariable[]): VariableGroup[] {
  const isHidden = (v: StackVariable) =>
    v.meta?.type === 'secret' ||
    v.meta?.type === 'rsa-private' ||
    v.meta?.type === 'bcrypt';

  const groups = new Map<string, StackVariable[]>();
  for (const v of variables) {
    if (isHidden(v)) continue; // never displayed
    const key = v.global ? '_global' : (v.meta?.templateName || '_other');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
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
      label: DISPLAY_NAMES[key] || key,
      variables: vars,
    });
  }
  if (otherEntry && otherEntry.length > 0) {
    result.push({ key: '_other', label: 'Other', variables: otherEntry });
  }
  return result;
}
