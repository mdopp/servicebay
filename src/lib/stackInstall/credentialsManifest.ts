/**
 * Manifest of every credential the install wizard auto-generates.
 *
 * Used for:
 *  - the end-of-install summary banner in the live install log
 *  - the credentials table on the Done step
 *  - the Bitwarden-CSV export so users can bulk-import into Vaultwarden
 *
 * The list is built from the wizard's own variables array, so secrets the
 * user override-typed survive into the export.
 */

import type { StackVariable } from './postInstall';

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
}

interface BuildOpts {
  selected: { name: string }[];
  variables: StackVariable[];
  /** Hostname or IP the user is browsing ServiceBay through. Used to build
   *  reachable URLs in the manifest. Empty string falls back to the
   *  `<server-ip>` placeholder. */
  host?: string;
  /** Templates whose post-deploy.py emitted their own credential markers.
   *  This builder skips its hardcoded branches for those stacks so the
   *  SAVE-THESE-NOW banner doesn't double-list the same entry once from
   *  the script (via `__SB_CREDENTIAL__`) and once from here. */
  skipDefaults?: Set<string>;
}

const get = (vars: StackVariable[], name: string): string | undefined =>
  vars.find(v => v.name === name)?.value;

export function buildCredentialsManifest(opts: BuildOpts): Credential[] {
  const { variables: v, skipDefaults } = opts;
  const handled = (n: string): boolean => skipDefaults?.has(n) ?? false;
  const isSelected = (n: string) => opts.selected.some(i => i.name === n) && !handled(n);
  const host = opts.host || '<server-ip>';
  const out: Credential[] = [];

  // LLDAP + Authelia live in the merged 'auth' stack now; the variables
  // and credentials shapes are unchanged, only the gating template name.
  if (isSelected('auth')) {
    const port = get(v, 'LLDAP_PORT') || '17170';
    const password = get(v, 'LLDAP_ADMIN_PASSWORD');
    if (password) {
      out.push({
        service: 'LLDAP (User Directory)',
        url: `http://${host}:${port}`,
        username: 'admin',
        password,
        importance: 'critical',
        notes: 'Manage users + groups here. Required to add family members.',
      });
    }
  }

  if (isSelected('nginx-web')) {
    const adminPort = get(v, 'NGINX_ADMIN_PORT') || '81';
    const email = get(v, 'NGINX_ADMIN_EMAIL') || 'admin@servicebay.local';
    const password = get(v, 'NGINX_ADMIN_PASSWORD');
    if (password) {
      out.push({
        service: 'Nginx Proxy Manager',
        url: `http://${host}:${adminPort}`,
        username: email,
        password,
        importance: 'critical',
        notes: 'Reverse-proxy admin. Needed for SSL cert renewal + access lists.',
      });
    }
  }

  if (isSelected('adguard')) {
    const port = get(v, 'ADGUARD_ADMIN_PORT') || '8083';
    const username = get(v, 'ADGUARD_ADMIN_USER') || 'admin';
    const password = get(v, 'ADGUARD_ADMIN_PASSWORD');
    if (password) {
      out.push({
        service: 'AdGuard Home',
        url: `http://${host}:${port}`,
        username,
        password,
        importance: 'critical',
        notes: 'DNS console. Add custom rewrites + manage blocklists.',
      });
    }
  }

  // Audiobookshelf + Navidrome live in the merged 'media' stack now.
  if (isSelected('media')) {
    const absPort = get(v, 'ABS_PORT') || '13378';
    const absUser = get(v, 'ABS_ADMIN_USER') || 'root';
    const absPassword = get(v, 'ABS_ADMIN_PASSWORD');
    if (absPassword) {
      out.push({
        service: 'Audiobookshelf',
        url: `http://${host}:${absPort}`,
        username: absUser,
        password: absPassword,
        importance: 'critical',
        notes: 'Library manager. Mobile apps use this credential too.',
      });
    }

    const ndPort = get(v, 'NAVIDROME_PORT') || '4533';
    const ndUser = get(v, 'NAVIDROME_ADMIN_USER') || 'admin';
    const ndPassword = get(v, 'NAVIDROME_ADMIN_PASSWORD');
    if (ndPassword) {
      out.push({
        service: 'Navidrome',
        url: `http://${host}:${ndPort}`,
        username: ndUser,
        password: ndPassword,
        importance: 'critical',
        notes: 'Music server. Symfonium / Subsonic clients use this too.',
      });
    }
  }

  if (isSelected('file-share')) {
    const username = get(v, 'SHARE_USER') || 'samba';
    const password = get(v, 'SHARE_PASSWORD');
    if (password) {
      out.push({
        service: 'Samba (file-share)',
        url: `\\\\${host}\\data`,
        username,
        password,
        importance: 'critical',
        notes: 'Windows network drive. Type once per PC when mounting.',
      });
    }
  }

  // ─── system-internal secrets (rarely needed, kept for DR) ────────────

  // OIDC client secrets — derive entirely from variables[].meta.oidcClient so
  // the client_id "username" stays in lock-step with templates/.../variables.json.
  // Previously this section hardcoded `username: 'audiobookshelf'`, which is
  // exactly the kind of dual-source-of-truth duplication we're trying to kill.
  const domain = get(v, 'PUBLIC_DOMAIN');
  for (const sv of v) {
    const oidc = sv.meta?.oidcClient;
    if (!oidc) continue;
    const secretVar = oidc.clientSecretVar;
    if (!secretVar) continue;
    const secret = get(v, secretVar);
    if (!secret) continue;
    // `clientSecretVar` means the secret is wired into the container env
    // (e.g. SSO_CLIENT_SECRET) — there's nothing to paste into a UI. The
    // entry exists only for disaster recovery / cross-stack restoration.
    out.push({
      service: `${oidc.client_name || oidc.client_id} OIDC client_secret`,
      url: domain ? `https://auth.${domain}` : 'auth.<domain>',
      username: oidc.client_id,
      password: secret,
      importance: 'system',
      notes: 'Wired into the container env (SSO_CLIENT_SECRET) automatically — save for disaster recovery only.',
    });
  }

  // Vaultwarden's OIDC entry is emitted by the variable-driven loop above.
  // The only Vaultwarden-specific bit is the SSO_ENABLED hint, which we
  // append to the matching existing entry rather than duplicate the whole
  // credential. This keeps client_id sourced from variables.json and avoids
  // the dual source-of-truth that the consistency test now forbids.
  if (isSelected('vaultwarden')) {
    const enabled = get(v, 'VAULTWARDEN_SSO_ENABLED') === 'true';
    const entry = out.find(c => /Vaultwarden OIDC/i.test(c.service));
    if (entry) {
      entry.notes = enabled
        ? 'SSO is enabled. Already wired into the container env (SSO_CLIENT_SECRET) — no manual paste needed.'
        : 'SSO is OFF. To enable: flip VAULTWARDEN_SSO_ENABLED=true and redeploy.';
    }
  }

  if (isSelected('auth')) {
    const seed = get(v, 'LLDAP_JWT_SECRET');
    if (seed) {
      out.push({
        service: 'LLDAP JWT secret',
        url: 'env: LLDAP_JWT_SECRET',
        username: '—',
        password: seed,
        importance: 'system',
        notes: 'Signs LLDAP user sessions. Save for disaster recovery — without it old browser cookies become invalid after a restore.',
      });
    }
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
    '🔑 SAVE THESE NOW — they are not shown again',
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
  lines.push('💡 You can also download a Bitwarden-compatible CSV from the Done step.');
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
