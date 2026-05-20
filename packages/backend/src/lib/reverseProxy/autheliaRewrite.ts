/**
 * Pure transform from the install-time Authelia `configuration.yml`
 * to its post-migration counterpart, used by the LAN→Public migration
 * orchestrator (#265).
 *
 * The migration is "soft handoff": existing LAN URLs keep working,
 * with public-domain twins added side-by-side in access_control rules
 * and OIDC redirect_uris. The single non-additive change is the
 * session cookie domain — Authelia binds one cookie per session.cookies[i],
 * so the cookie's `domain` flips from the lan root to the public root.
 * That invalidates active sessions; the locked design surfaces this
 * via a pre-flight banner.
 *
 * Kept as a string-in / string-out function with no I/O so the surface
 * is fully unit-testable. Callers (the orchestrator) do the
 * read-file → rewrite → write-file → restart-pod dance.
 */

import yaml from 'js-yaml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlNode = any;

export interface AutheliaRewriteChanges {
  /** Cookie domain flipped from lan root to public domain. */
  cookieDomain: { from: string | null; to: string };
  /** Cookie authelia_url rewritten to the public auth subdomain. */
  cookieAutheliaUrl: { from: string | null; to: string };
  /**
   * Per-rule before/after of `access_control.rules[i].domain`.
   * Empty when the rules array was missing.
   */
  accessControlRuleDomains: { from: unknown; to: unknown }[];
  /**
   * Per-client list of newly-appended `redirect_uris`. Existing entries
   * are preserved untouched (additive, per the locked design).
   */
  oidcRedirectUriAdditions: { clientId: string; added: string[] }[];
}

export interface AutheliaRewriteResult {
  /** Rewritten yaml, ready to write back. */
  yaml: string;
  /** What changed — for plan output + post-apply audit log. */
  changes: AutheliaRewriteChanges;
}

/**
 * Twin a single hostname string against the public domain.
 *
 * - `home.arpa` → `[home.arpa, dopp.cloud]`
 * - `auth.home.arpa` → `[auth.home.arpa, auth.dopp.cloud]`
 * - anything else → returned unchanged
 *
 * Returns either the input string (no match) or a deduplicated array
 * containing the original plus the public-domain twin.
 */
function twinHost(value: string, lanRoot: string, publicDomain: string): string | string[] {
  const lc = value.toLowerCase();
  const lan = lanRoot.toLowerCase();
  if (lc === lan) {
    return value === publicDomain ? [value] : [value, publicDomain];
  }
  if (lc.endsWith(`.${lan}`)) {
    const sub = value.slice(0, value.length - lan.length - 1);
    const twin = `${sub}.${publicDomain}`;
    return value === twin ? [value] : [value, twin];
  }
  return value;
}

/**
 * Twin a `domain` field on an access_control rule. Handles both forms
 * Authelia accepts: a single string or a list of strings.
 *
 * For lists, every entry that matches the lan root contributes a new
 * public-domain entry. Existing entries are preserved verbatim. The
 * result is deduplicated so a re-run of the migration is a no-op on
 * already-migrated config.
 */
function twinAccessControlDomain(value: unknown, lanRoot: string, publicDomain: string): unknown {
  if (typeof value === 'string') {
    return twinHost(value, lanRoot, publicDomain);
  }
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    const push = (v: string) => {
      if (seen.has(v)) return;
      seen.add(v);
      out.push(v);
    };
    for (const item of value) {
      if (typeof item !== 'string') {
        out.push(item);
        continue;
      }
      const twinned = twinHost(item, lanRoot, publicDomain);
      if (typeof twinned === 'string') {
        push(twinned);
      } else {
        for (const t of twinned) push(t);
      }
    }
    return out;
  }
  return value;
}

/**
 * Compute the public-domain twin of a URI whose host is the lan root
 * (or a subdomain of it). Returns `null` for any URI that doesn't
 * involve the lan root (third-party callbacks, mobile deep-links,
 * already-public URIs) so the caller can skip them cleanly.
 */
function twinUri(uri: string, lanRoot: string, publicDomain: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const lan = lanRoot.toLowerCase();
  if (host === lan) {
    parsed.hostname = publicDomain;
    return parsed.toString();
  }
  if (host.endsWith(`.${lan}`)) {
    const sub = parsed.hostname.slice(0, parsed.hostname.length - lan.length - 1);
    parsed.hostname = `${sub}.${publicDomain}`;
    return parsed.toString();
  }
  return null;
}

/**
 * Compute the new `cookies[i].authelia_url`. Existing value is parsed
 * as a URL so a non-default port or path on the existing url survives
 * the migration. Falls back to `https://auth.<publicDomain>` if the
 * existing value is missing or malformed.
 */
function rewriteAutheliaUrl(existing: unknown, lanRoot: string, publicDomain: string): string {
  if (typeof existing === 'string') {
    try {
      const u = new URL(existing);
      const host = u.hostname.toLowerCase();
      if (host === lanRoot.toLowerCase() || host.endsWith(`.${lanRoot.toLowerCase()}`)) {
        const sub = host === lanRoot.toLowerCase()
          ? 'auth'
          : (host.slice(0, host.length - lanRoot.length - 1) || 'auth');
        u.hostname = `${sub}.${publicDomain}`;
        return u.toString();
      }
      // URL is already off the lan root (e.g. a second-run on a
      // migrated config); leave it untouched so the rewrite stays
      // idempotent.
      return existing;
    } catch {
      // fall through to default
    }
  }
  return `https://auth.${publicDomain}`;
}

/**
 * Re-emit yaml using the same serialisation defaults as the existing
 * `oidc-clients/route.ts` editor so diffs against an Authelia config
 * touched by either path stay readable.
 */
function dumpYaml(node: YamlNode): string {
  return yaml.dump(node, { lineWidth: -1, quotingType: "'", forceQuotes: false });
}

/**
 * Walk a parsed `configuration.yml` and return the
 * `[yaml, changes]` pair. Idempotent — running the rewrite a second
 * time on already-migrated config yields the same string + empty
 * change lists for the additive sections.
 */
export function rewriteAutheliaConfig(
  yamlString: string,
  lanRoot: string,
  publicDomain: string,
): AutheliaRewriteResult {
  const doc = yaml.load(yamlString) as YamlNode;
  const changes: AutheliaRewriteChanges = {
    cookieDomain: { from: null, to: publicDomain },
    cookieAutheliaUrl: { from: null, to: '' },
    accessControlRuleDomains: [],
    oidcRedirectUriAdditions: [],
  };

  if (!doc || typeof doc !== 'object') {
    return { yaml: yamlString, changes };
  }

  // 1) Session cookie — single config value, hard cutover.
  const cookies = doc?.session?.cookies;
  if (Array.isArray(cookies) && cookies.length > 0 && cookies[0] && typeof cookies[0] === 'object') {
    const c = cookies[0];
    changes.cookieDomain.from = typeof c.domain === 'string' ? c.domain : null;
    c.domain = publicDomain;

    changes.cookieAutheliaUrl.from = typeof c.authelia_url === 'string' ? c.authelia_url : null;
    c.authelia_url = rewriteAutheliaUrl(c.authelia_url, lanRoot, publicDomain);
    changes.cookieAutheliaUrl.to = c.authelia_url;
  }

  // 2) Access-control rules — additive twin.
  const rules = doc?.access_control?.rules;
  if (Array.isArray(rules)) {
    for (const r of rules) {
      if (!r || typeof r !== 'object' || !('domain' in r)) continue;
      const before = r.domain;
      const after = twinAccessControlDomain(before, lanRoot, publicDomain);
      // Only log a change when something actually moved. Arrays compare
      // structurally; strings compare directly.
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        r.domain = after;
        changes.accessControlRuleDomains.push({ from: before, to: after });
      }
    }
  }

  // 3) OIDC clients — append public-domain redirect_uri twins.
  const clients = doc?.identity_providers?.oidc?.clients;
  if (Array.isArray(clients)) {
    for (const client of clients) {
      if (!client || typeof client !== 'object') continue;
      const uris = client.redirect_uris;
      if (!Array.isArray(uris)) continue;
      const existing = new Set<string>();
      for (const u of uris) {
        if (typeof u === 'string') existing.add(u);
      }
      const added: string[] = [];
      for (const u of uris.slice()) {
        if (typeof u !== 'string') continue;
        const twin = twinUri(u, lanRoot, publicDomain);
        if (twin && !existing.has(twin)) {
          existing.add(twin);
          uris.push(twin);
          added.push(twin);
        }
      }
      if (added.length > 0) {
        changes.oidcRedirectUriAdditions.push({
          clientId: typeof client.client_id === 'string' ? client.client_id : '(unknown)',
          added,
        });
      }
    }
  }

  return { yaml: dumpYaml(doc), changes };
}
