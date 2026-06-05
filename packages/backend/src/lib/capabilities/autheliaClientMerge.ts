/**
 * Preserve other stacks' OIDC clients across an auth redeploy (#1724).
 *
 * The `auth` template ships `configuration.yml.mustache` with only its own
 * baked-in `servicebay` OIDC client. Every other SSO-enabled stack (immich,
 * vaultwarden, audiobookshelf, home-assistant, …) registers its client
 * *incrementally* into Authelia's on-disk `configuration.yml` via
 * `POST /api/system/authelia/oidc-clients` after it installs. There is no
 * side-store of the full client set.
 *
 * So when the `auth` stack re-renders `configuration.yml` from the mustache
 * on a redeploy, the freshly rendered file contains ONLY `servicebay` — and
 * writing it to disk DROPS every incrementally-registered client. Result: a
 * full SSO outage (`invalid_client` for everything but ServiceBay) until each
 * owning stack is redeployed (#1724, #1559 family).
 *
 * `mergeAutheliaOidcClients` is the deterministic fix: before the freshly
 * rendered auth config is written, merge back any clients that already exist
 * in the on-disk config but aren't in the fresh render. Properties:
 *
 *   - **Preserves every existing client verbatim** — including its
 *     `client_secret`. We never rotate an already-registered secret (that
 *     rotation is the #1559 drift this whole family is about).
 *   - **The fresh render wins for shared client_ids** — `servicebay`'s block
 *     comes from the template, so a template change to the baseline client
 *     (new redirect_uri, policy, …) still lands.
 *   - **Idempotent** — re-running with the same inputs yields the same output;
 *     no duplicate client_ids (dedup is by `client_id`).
 *
 * Pure + sync so the install path can apply it inline and it's trivially
 * unit-testable. Fail-soft by contract: if either document can't be parsed as
 * the expected shape, return the freshly rendered config unchanged (never
 * throw) — a redeploy must not be blocked by a malformed on-disk file.
 */
import yaml from 'js-yaml';

interface OidcClient {
  client_id?: unknown;
  [k: string]: unknown;
}

function readClients(doc: unknown): OidcClient[] {
  if (!doc || typeof doc !== 'object') return [];
  const idp = (doc as Record<string, unknown>).identity_providers;
  if (!idp || typeof idp !== 'object') return [];
  const oidc = (idp as Record<string, unknown>).oidc;
  if (!oidc || typeof oidc !== 'object') return [];
  const clients = (oidc as Record<string, unknown>).clients;
  return Array.isArray(clients) ? (clients as OidcClient[]) : [];
}

function clientId(c: OidcClient): string | null {
  return typeof c.client_id === 'string' && c.client_id ? c.client_id : null;
}

/**
 * Merge the OIDC clients already present in the on-disk Authelia config into a
 * freshly rendered one, so a `configuration.yml` re-render never drops the
 * incrementally-registered clients of other installed stacks.
 *
 * @param renderedConfig  the freshly mustache-rendered auth `configuration.yml`
 *                        (baseline: only the auth template's own client(s)).
 * @param existingConfig  the current on-disk `configuration.yml`, or '' / null
 *                        on a fresh install where no file exists yet.
 * @returns the merged YAML to write. On a fresh install (no existing config),
 *          or if either side can't be parsed, returns `renderedConfig` as-is.
 */
export function mergeAutheliaOidcClients(
  renderedConfig: string,
  existingConfig: string | null | undefined,
): string {
  if (!existingConfig || !existingConfig.trim()) return renderedConfig;

  let renderedDoc: unknown;
  let existingDoc: unknown;
  try {
    renderedDoc = yaml.load(renderedConfig);
    existingDoc = yaml.load(existingConfig);
  } catch {
    // A malformed document on either side — don't block the redeploy. The
    // fresh render is at least valid; ship it unchanged.
    return renderedConfig;
  }

  const renderedClients = readClients(renderedDoc);
  const existingClients = readClients(existingDoc);
  if (existingClients.length === 0) return renderedConfig;

  // The fresh render is authoritative for any client_id it declares (so a
  // baseline-client change still lands); every other existing client is
  // appended verbatim, secret intact.
  const renderedIds = new Set(
    renderedClients.map(clientId).filter((id): id is string => id !== null),
  );
  const preserved: OidcClient[] = [];
  const seen = new Set<string>(renderedIds);
  for (const c of existingClients) {
    const id = clientId(c);
    if (!id || seen.has(id)) continue; // drop dupes + anything the render owns
    seen.add(id);
    preserved.push(c);
  }
  if (preserved.length === 0) return renderedConfig;

  // Splice preserved clients onto the rendered doc's client list. Reuse the
  // rendered doc object so all of the rendered config (hmac/jwks/policies) is
  // untouched — we only extend clients[].
  const doc = renderedDoc as Record<string, unknown>;
  const idp = (doc.identity_providers ??= {}) as Record<string, unknown>;
  const oidc = (idp.oidc ??= {}) as Record<string, unknown>;
  oidc.clients = [...renderedClients, ...preserved];

  return yaml.dump(doc, { lineWidth: -1, quotingType: "'", forceQuotes: false });
}
