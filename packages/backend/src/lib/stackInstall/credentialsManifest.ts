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

/**
 * Merge a freshly-built credentials manifest into a previously persisted
 * one, keyed by owning template.
 *
 * The install runner calls this at end-of-job to keep
 * `config.installManifest` complete. Entries owned by a template in
 * `deployedTemplates` are dropped (the run just rebuilt them, so `fresh`
 * carries the current values); entries owned by *other* templates — and
 * legacy untagged entries — are preserved, so a feature-only install
 * doesn't wipe credentials captured by earlier installs.
 *
 * Same per-template-replace semantics as the credentials capability
 * handler (`capabilities/credentials.ts`), generalised to the set of
 * templates one install job touched.
 */
export function mergeCredentials(
  existing: Credential[],
  fresh: Credential[],
  deployedTemplates: readonly string[],
): Credential[] {
  const deployed = new Set(deployedTemplates);
  const kept = existing.filter(c => !c.template || !deployed.has(c.template));
  return [...kept, ...fresh];
}

// #632 removed `formatCredentialsBanner` — the install runner no longer
// dumps the manifest into the deploy log. The wizard's Done UI reads
// the same data from `job.credentialsManifest` and the credentials
// capability handler persists each template's entries to
// `config.installManifest`.

/**
 * Minimal proxy-host shape the URL resolver needs — a subset of the
 * backend `ProxyHostEntry` (config.ts) so this stays importable from the
 * api-client/frontend without dragging in the full config types.
 */
export interface CredentialUrlHost {
  /** Full subdomain, e.g. "ldap.dopp.cloud". */
  domain: string;
  /** Owning template name, e.g. "auth", "nginx", "adguard". */
  service: string;
}

export interface CredentialUrlContext {
  hosts?: CredentialUrlHost[];
  publicDomain?: string;
}

/**
 * True only for browser-navigable http(s) URLs. Everything else a
 * post-deploy might stash in the `url` field — `env: LLDAP_JWT_SECRET`,
 * `\\localhost\data`, `(bearer token)`, `ssh://dev@localhost:2222`,
 * the `<server-ip>` placeholder — returns false so the UI renders it as
 * plain text instead of a dead link.
 */
export function isHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '<server-ip>', '[::1]']);

/**
 * Resolve the admin-reachable URL for a credential row (#1626).
 *
 * post-deploy.py scripts emit `http://<HOST>:<port>` where HOST defaults
 * to the box's loopback — useless from an admin's browser. Every admin
 * console already has a public subdomain behind Authelia, recorded in
 * `reverseProxy.hosts[]`. So when a credential points at a loopback host
 * and we can find the owning service's proxy host, rewrite it to
 * `https://<subdomain>`.
 *
 * - Non-http(s) values (`env:`, `\\…`, `ssh://`, bearer tokens) pass
 *   through untouched — the caller renders them as plain text.
 * - http(s) URLs that aren't loopback (already a real subdomain, e.g. the
 *   LLDAP per-user link) pass through untouched.
 * - Loopback http(s) URLs are rewritten when a matching proxy host exists
 *   (by `template`, else by template-name substring of the service label),
 *   preserving the original path/hash. No match ⇒ original returned.
 */
export function resolveCredentialUrl(
  cred: Pick<Credential, 'url' | 'service' | 'template'>,
  ctx: CredentialUrlContext,
): string {
  const raw = (cred.url ?? '').trim();
  if (!isHttpUrl(raw)) return raw;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return raw;

  const hosts = ctx.hosts ?? [];
  if (hosts.length === 0) return raw;

  const serviceLabel = (cred.service ?? '').toLowerCase();
  const match =
    (cred.template && hosts.find(h => h.service === cred.template)) ||
    hosts.find(h => h.service && serviceLabel.includes(h.service.toLowerCase()));
  if (!match || !match.domain) return raw;

  return `https://${match.domain}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Build a Bitwarden-import-ready CSV. Bitwarden's importer is forgiving on
 *  column order; we use the canonical set documented at
 *  https://bitwarden.com/help/condition-bitwarden-import/.
 *
 *  When a `ctx` is supplied, each row's `login_uri` is run through
 *  `resolveCredentialUrl` so loopback URLs become the admin-reachable
 *  public subdomain (#1626) — keeping the CSV import in lock-step with
 *  what the Saved-credentials table shows. */
export function buildBitwardenCsv(manifest: Credential[], ctx: CredentialUrlContext = {}): string {
  const escape = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const header = [
    'folder', 'favorite', 'type', 'name', 'notes',
    'fields', 'reprompt',
    'login_uri', 'login_username', 'login_password', 'login_totp',
  ].join(',');

  const rows = manifest.map(c => {
    const resolved = resolveCredentialUrl(c, ctx);
    return [
      escape('ServiceBay Home'),
      '',
      escape('login'),
      escape(c.service),
      escape(`${c.notes || ''}${c.importance === 'system' ? '\n[system / DR — usually not needed for daily use]' : ''}`.trim()),
      '',
      '',
      // Only http(s) URLs are valid login_uri values; non-URL hints stay out.
      escape(isHttpUrl(resolved) ? resolved : ''),
      escape(c.username),
      escape(c.password),
      '',
    ].join(',');
  });

  return [header, ...rows].join('\n') + '\n';
}
