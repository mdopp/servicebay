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
}

const get = (vars: StackVariable[], name: string): string | undefined =>
  vars.find(v => v.name === name)?.value;

export function buildCredentialsManifest(opts: BuildOpts): Credential[] {
  const { variables: v } = opts;
  const isSelected = (n: string) => opts.selected.some(i => i.name === n);
  const host = opts.host || '<server-ip>';
  const out: Credential[] = [];

  if (isSelected('lldap')) {
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

  if (isSelected('audiobookshelf')) {
    const port = get(v, 'ABS_PORT') || '13378';
    const username = get(v, 'ABS_ADMIN_USER') || 'root';
    const password = get(v, 'ABS_ADMIN_PASSWORD');
    if (password) {
      out.push({
        service: 'Audiobookshelf',
        url: `http://${host}:${port}`,
        username,
        password,
        importance: 'critical',
        notes: 'Library manager. Mobile apps use this credential too.',
      });
    }
  }

  if (isSelected('navidrome')) {
    const port = get(v, 'NAVIDROME_PORT') || '4533';
    const username = get(v, 'NAVIDROME_ADMIN_USER') || 'admin';
    const password = get(v, 'NAVIDROME_ADMIN_PASSWORD');
    if (password) {
      out.push({
        service: 'Navidrome',
        url: `http://${host}:${port}`,
        username,
        password,
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

  if (isSelected('audiobookshelf')) {
    const secret = get(v, 'ABS_OIDC_SECRET');
    const domain = get(v, 'PUBLIC_DOMAIN');
    if (secret) {
      out.push({
        service: 'Audiobookshelf OIDC client_secret',
        url: domain ? `https://auth.${domain}` : 'auth.<domain>',
        username: 'audiobookshelf',
        password: secret,
        importance: 'system',
        notes: 'Paste into ABS Settings → Authentication → OIDC client_secret to enable SSO.',
      });
    }
  }

  if (isSelected('vaultwarden')) {
    const secret = get(v, 'VAULTWARDEN_SSO_SECRET');
    const enabled = get(v, 'VAULTWARDEN_SSO_ENABLED') === 'true';
    if (secret) {
      out.push({
        service: 'Vaultwarden OIDC client_secret',
        url: 'env: SSO_CLIENT_SECRET',
        username: 'vaultwarden',
        password: secret,
        importance: 'system',
        notes: enabled
          ? 'SSO is enabled. Already wired into the container env — no manual paste needed.'
          : 'SSO is OFF. To enable: flip VAULTWARDEN_SSO_ENABLED=true and redeploy.',
      });
    }
  }

  if (isSelected('lldap')) {
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
