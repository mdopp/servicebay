/**
 * Manifest of every credential the install wizard auto-generates.
 *
 * Used for:
 *  - the end-of-install summary banner in the live install log
 *  - the credentials table on the Done step
 *  - the Bitwarden-CSV export so users can bulk-import into Vaultwarden
 *
 * Almost every entry is contributed by a template's post-deploy.py via
 * `__SB_CREDENTIAL__` markers — those are merged in by the wizard before
 * calling buildCredentialsManifest. The only entries this module
 * generates itself are the OIDC client_secret system entries, derived
 * from variables[].meta.oidcClient.clientSecretVar — that part is
 * variable-driven (no per-template knowledge) so it stays here.
 */

import type { StackVariable } from './types';

export interface Credential {
  /** User-facing service name, e.g. "LLDAP" or "Audiobookshelf". */
  service: string;
  /** Reachable URL or URI hint. Use `<server-ip>` placeholder when host unknown. */
  url: string;
  username: string;
  password: string;
  /**
   * "critical" — user MUST log in here at some point (admin panels).
   * "system"   — internal secret the user normally never touches but might
   *              need for disaster recovery / external SSO config / etc.
   */
  importance: 'critical' | 'system';
  /** One-liner shown next to the entry. */
  notes?: string;
  /**
   * Owning template name (#631). Capability handlers use this to filter
   * the manifest on uninstall — entries without `template` (legacy
   * pre-Phase-4C entries) are never auto-removed. Set by
   * `buildCredentialsManifest` for OIDC entries and by post-deploy.py
   * `__SB_CREDENTIAL__` capture for runtime entries (which now carry
   * the captured template name).
   */
  template?: string;
}

interface BuildOpts {
  variables: StackVariable[];
  /** Hostname or IP the user is browsing ServiceBay through. Used to build
   *  reachable URLs in the manifest. Empty string falls back to the
   *  `<server-ip>` placeholder. */
  host?: string;
}

const get = (vars: StackVariable[], name: string): string | undefined =>
  vars.find(v => v.name === name)?.value;

export function buildCredentialsManifest(opts: BuildOpts): Credential[] {
  const { variables: v } = opts;
  const out: Credential[] = [];

  // OIDC client_secret entries — derived entirely from
  // variables[].meta.oidcClient.clientSecretVar so the username
  // (client_id) stays in lock-step with templates/.../variables.json.
  // `clientSecretVar` means the secret is wired into the container env
  // (e.g. SSO_CLIENT_SECRET) — there's nothing to paste into a UI. The
  // entry exists only for disaster recovery / cross-stack restoration.
  const domain = get(v, 'PUBLIC_DOMAIN');
  for (const sv of v) {
    const oidc = sv.meta?.oidcClient;
    if (!oidc) continue;
    const secretVar = oidc.clientSecretVar;
    if (!secretVar) continue;
    const secret = get(v, secretVar);
    if (!secret) continue;
    out.push({
      service: `${oidc.client_name || oidc.client_id} OIDC client_secret`,
      url: domain ? `https://auth.${domain}` : 'auth.<domain>',
      username: oidc.client_id,
      password: secret,
      importance: 'system',
      notes: 'Wired into the container env (SSO_CLIENT_SECRET) automatically — save for disaster recovery only.',
      // #631: tag with owning template so uninstall can remove it.
      template: sv.meta?.templateName,
    });
  }

  return out;
}

/** Format a manifest as a banner-style block for the install log. */
export function formatCredentialsBanner(manifest: Credential[]): string[] {
  if (manifest.length === 0) return [];
  const critical = manifest.filter(c => c.importance === 'critical');
  const system = manifest.filter(c => c.importance === 'system');
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════',
    'CREDENTIALS — saved encrypted at Settings → Integrations → Saved credentials',
    '═══════════════════════════════════════════════════',
  ];
  for (const c of critical) {
    lines.push(`  ${c.service}`);
    lines.push(`    URL:      ${c.url}`);
    lines.push(`    User:     ${c.username}`);
    lines.push(`    Password: ${c.password}`);
    if (c.notes) lines.push(`    ↳ ${c.notes}`);
    lines.push('');
  }
  if (system.length) {
    lines.push('───── system / disaster-recovery (rarely needed) ─────');
    for (const c of system) {
      lines.push(`  ${c.service}: ${c.password}`);
      if (c.notes) lines.push(`    ↳ ${c.notes}`);
    }
    lines.push('');
  }
  lines.push('Visible in Settings → Integrations → Saved credentials, or download a Bitwarden CSV from the Done step.');
  lines.push('═══════════════════════════════════════════════════');
  return lines;
}

/** Build a Bitwarden-import-ready CSV. Bitwarden's importer is forgiving on
 *  column order; we use the canonical set documented at
 *  https://bitwarden.com/help/condition-bitwarden-import/. */
export function buildBitwardenCsv(manifest: Credential[]): string {
  const escape = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const header = [
    'folder', 'favorite', 'type', 'name', 'notes',
    'fields', 'reprompt',
    'login_uri', 'login_username', 'login_password', 'login_totp',
  ].join(',');

  const rows = manifest.map(c => [
    escape('ServiceBay Home'),
    '',
    escape('login'),
    escape(c.service),
    escape(`${c.notes || ''}${c.importance === 'system' ? '\n[system / DR — usually not needed for daily use]' : ''}`.trim()),
    '',
    '',
    escape(c.url),
    escape(c.username),
    escape(c.password),
    '',
  ].join(','));

  return [header, ...rows].join('\n') + '\n';
}
