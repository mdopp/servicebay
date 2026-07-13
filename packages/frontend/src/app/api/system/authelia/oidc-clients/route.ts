import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getNodeTwins } from '@/lib/store/repository';
import { getTemplateVariables } from '@/lib/registry';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import crypto from 'crypto';
import yaml from 'js-yaml';

/** Restrict redirect_uris so a malicious template (or a future bug) can't
 *  register a callback to attacker.com. Allows:
 *   - relative paths (rewritten under the service's own subdomain)
 *   - custom URI schemes (mobile deep-links like `app.immich:/`)
 *   - http(s) URIs whose host is the configured publicDomain or one of
 *     its subdomains
 *  Returns the URI if accepted, or null if it should be dropped. */
function safeRedirectUri(uri: string, fqdn: string, publicDomain: string): string | null {
  // Relative path → always rewritten under the service's own subdomain.
  if (!uri.startsWith('http') && !uri.includes(':/')) {
    return `https://${fqdn}${uri}`;
  }
  try {
    const u = new URL(uri);
    // Mobile / native-app deep links use custom schemes (e.g. `app.immich:/auth`).
    // These don't carry a host the IDP can spoof, so let them through.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return uri;
    const host = u.hostname.toLowerCase();
    const root = publicDomain.toLowerCase();
    // Allow exact root or any subdomain of the configured public domain.
    if (host === root || host.endsWith(`.${root}`)) return uri;
    return null;
  } catch {
    return null;
  }
}

const OIDC_SECRET_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * One uniform index into `OIDC_SECRET_CHARS` via rejection sampling: draw a
 * random byte and discard any in the biased tail above the largest multiple of
 * the charset size. `byte % len` skews the distribution whenever 256 isn't a
 * multiple of `len` (js/biased-cryptographic-random) — the 62-char alphabet is
 * exactly such a case. This gives a provably-unbiased pick. Exported for tests.
 */
export function unbiasedOidcCharIndex(len: number = OIDC_SECRET_CHARS.length): number {
  const limit = Math.floor(256 / len) * len; // largest multiple of len ≤ 256
  let byte: number;
  do {
    byte = crypto.randomBytes(1)[0];
  } while (byte >= limit);
  return byte % len;
}

export function generateSecret(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += OIDC_SECRET_CHARS[unbiasedOidcCharIndex()];
  }
  return out;
}

/**
 * Strip Authelia's stored-secret format prefix off an on-disk
 * `client_secret`. Authelia stores plaintext client secrets as
 * `$plaintext$<secret>` (and hashed ones as `$pbkdf2-sha512$…` / `$argon2…`).
 * The service side (immich system_metadata, vaultwarden env, …) holds the
 * RAW secret, so a reused secret must be the un-prefixed plaintext.
 *
 * Returns the raw plaintext for a `$plaintext$`-prefixed value, the value
 * verbatim if it carries no recognised prefix, or `null` for a hashed
 * secret (which can't be recovered to plaintext — caller must regenerate).
 */
export function extractPlaintextSecret(stored: unknown): string | null {
  if (typeof stored !== 'string' || !stored) return null;
  if (stored.startsWith('$plaintext$')) {
    const raw = stored.slice('$plaintext$'.length);
    return raw || null;
  }
  // A hashed secret ($pbkdf2…/$argon2…) is one-way — not reusable as the
  // raw value the service holds. Signal "no reusable plaintext".
  if (stored.startsWith('$')) return null;
  // No prefix → already raw plaintext (legacy / hand-edited config).
  return stored;
}

/**
 * #1738 — pick the client_secret for a (re)registration, reconcile-first.
 *
 * The invariant (ADR 0009): the secret in Authelia's client and the secret
 * the consuming service holds must be the SAME value, and re-registering an
 * existing client must NEVER rotate it (regeneration is the drift that
 * caused `invalid_client` after every reinstall/redeploy).
 *
 * Resolution order:
 *   1. **Persisted on-disk secret** (the already-registered client's
 *      `client_secret`, un-prefixed) — the source of truth the service was
 *      configured against. Reuse it verbatim. This is the reconcile path.
 *   2. **Wizard-supplied secret** (`variables[clientSecretVar]`) — first
 *      install, where the same value is written to the service env and here.
 *   3. **Generate once** — brand-new client with no persisted and no
 *      supplied secret.
 *
 * @param persistedSecret  the existing client's on-disk `client_secret`
 *                         (with Authelia's `$plaintext$` prefix), or
 *                         undefined when the client isn't registered yet.
 * @param suppliedSecret   `variables[clientSecretVar]`, when the template
 *                         pins a secret var and the wizard provided a value.
 * @param generate         secret factory (injected for testability).
 * @returns `{ secret, reused }` — `reused` true when an existing secret was
 *          kept (cases 1 & 2 with a real value), false when generated.
 */
export function resolveOidcClientSecret(
  persistedSecret: string | undefined,
  suppliedSecret: string | undefined,
  generate: () => string = generateSecret,
): { secret: string; reused: boolean } {
  const persisted = extractPlaintextSecret(persistedSecret);
  if (persisted) return { secret: persisted, reused: true };
  if (suppliedSecret) return { secret: suppliedSecret, reused: true };
  return { secret: generate(), reused: false };
}

interface OidcClientsRequest {
  /** Template names to extract OIDC client definitions from */
  templates: { name: string; source?: string }[];
  /** Variable values (needs PUBLIC_DOMAIN and *_SUBDOMAIN values) */
  variables: Record<string, string>;
}

/**
 * POST: Auto-register OIDC clients for deployed templates.
 * Looks up each template's variables.json for oidcClient definitions,
 * builds client configs, and appends them to Authelia's configuration.yml.
 */
export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body: OidcClientsRequest = await request.json();
    if (!body.templates?.length || !body.variables) {
      return NextResponse.json({ error: 'templates and variables required' }, { status: 400 });
    }

    const domain = body.variables.PUBLIC_DOMAIN;
    if (!domain) {
      return NextResponse.json({ error: 'PUBLIC_DOMAIN variable required' }, { status: 400 });
    }

    // Extract OIDC client definitions from template variables.json files
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clients: any[] = [];
    for (const tmpl of body.templates) {
      const meta = await getTemplateVariables(tmpl.name, tmpl.source);
      if (!meta) continue;

      for (const [varName, varMeta] of Object.entries(meta)) {
        const oidc = varMeta.oidcClient;
        if (!oidc || varMeta.type !== 'subdomain') continue;

        const subdomain = body.variables[varName];
        if (!subdomain) continue;

        const fqdn = `${subdomain}.${domain}`;
        const redirectUris = oidc.redirect_uris
          .map(uri => safeRedirectUri(uri, fqdn, domain))
          .filter((uri): uri is string => uri !== null);
        if (redirectUris.length === 0) continue; // skip rather than register an empty client

        // #1738 — defer the client_secret decision until after we've read
        // the on-disk Authelia config: a client that's already registered
        // must REUSE its persisted secret (the value the service was
        // configured against), never a freshly generated one. We carry the
        // wizard-supplied value (when the template pins a `clientSecretVar`)
        // and resolve the final secret per-client below via
        // `resolveOidcClientSecret`.
        const suppliedSecret = oidc.clientSecretVar
          ? body.variables[oidc.clientSecretVar]
          : undefined;

        clients.push({
          client_id: oidc.client_id,
          client_name: oidc.client_name,
          authorization_policy: oidc.authorization_policy,
          redirect_uris: redirectUris,
          scopes: oidc.scopes,
          supplied_secret: suppliedSecret,
          // RFC 6749 default is `client_secret_basic`. Templates whose
          // OIDC client library uses a different default (Immich's admin
          // API explicitly sends `client_secret_post`) override here.
          // Without this field, Authelia's registration locked every
          // client to `client_secret_post` and Vaultwarden's
          // `openidconnect-rs` calls failed with "client registration
          // does not allow this method" — operator-reported regression.
          token_endpoint_auth_method:
            oidc.token_endpoint_auth_method || 'client_secret_basic',
        });
      }
    }

    if (clients.length === 0) {
      return NextResponse.json({ added: [], skipped: [], message: 'No OIDC clients found in templates' });
    }

    // Find which node has Authelia deployed
    const nodes = Object.keys(getNodeTwins());
    let autheliaNode: string | null = null;
    let autheliaYaml = '';
    for (const nodeName of nodes) {
      try {
        // Authelia lives inside the merged 'auth' pod alongside LLDAP — read the
        // pod's manifest by stack name and pull authelia's config volume out of it.
        const files = await ServiceManager.getServiceFiles(nodeName, 'auth');
        if (files.yamlContent) {
          autheliaNode = nodeName;
          autheliaYaml = files.yamlContent;
          break;
        }
      } catch {
        // Not on this node
      }
    }

    if (!autheliaNode || !autheliaYaml) {
      return NextResponse.json({ error: 'Authelia is not deployed' }, { status: 404 });
    }

    // Find the config volume path from Authelia's pod YAML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs = yaml.loadAll(autheliaYaml) as any[];
    let configPath = '';
    for (const doc of docs) {
      const volumes = doc?.spec?.volumes;
      if (!Array.isArray(volumes)) continue;
      for (const vol of volumes) {
        if (vol.name?.includes('config') && vol.hostPath?.path) {
          configPath = vol.hostPath.path;
          break;
        }
      }
      if (configPath) break;
    }

    if (!configPath) {
      return NextResponse.json({ error: 'Could not find Authelia config volume' }, { status: 500 });
    }

    const configFilePath = `${configPath}/configuration.yml`;

    // Read the current Authelia configuration
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(autheliaNode);
    const readRes = await agent.sendCommand('read_file', { path: configFilePath });
    const currentConfig = readRes.content || readRes.stdout || '';

    if (!currentConfig) {
      return NextResponse.json({ error: 'Could not read Authelia configuration' }, { status: 500 });
    }

    // Parse the config to check for existing clients
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const autheliaConfig = yaml.load(currentConfig) as any;
    const existingClients = autheliaConfig?.identity_providers?.oidc?.clients || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingIds = new Set(existingClients.map((c: any) => c.client_id));
    // #1738 — map of already-persisted client_secret per client_id, so a
    // re-registration reconciles to the value the service was configured
    // against instead of minting a fresh one (the `invalid_client` drift).
    const persistedSecretById = new Map<string, string>();
    for (const c of existingClients) {
      if (typeof c?.client_id === 'string' && typeof c?.client_secret === 'string') {
        persistedSecretById.set(c.client_id, c.client_secret);
      }
    }

    const added: string[] = [];
    const skipped: string[] = [];

    for (const client of clients) {
      if (existingIds.has(client.client_id)) {
        // Already registered → leave it (and its persisted secret) untouched.
        // Reconcile-first by contract: we never rotate an existing secret.
        skipped.push(client.client_id);
        continue;
      }

      // #1738 — pick the secret reconcile-first: a persisted on-disk value
      // (if this client_id was registered before) wins, else the
      // wizard/installedSecrets-supplied value, else generate exactly once.
      const { secret } = resolveOidcClientSecret(
        persistedSecretById.get(client.client_id),
        client.supplied_secret,
      );

      existingClients.push({
        client_id: client.client_id,
        client_name: client.client_name,
        client_secret: `$plaintext$${secret}`,
        public: false,
        authorization_policy: client.authorization_policy || 'one_factor',
        redirect_uris: client.redirect_uris,
        scopes: client.scopes || ['openid', 'profile', 'email', 'groups'],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: client.token_endpoint_auth_method || 'client_secret_basic',
      });
      added.push(client.client_id);
    }

    if (added.length === 0) {
      return NextResponse.json({ added, skipped, message: 'All clients already registered' });
    }

    // Update the config and write it back
    if (!autheliaConfig.identity_providers) autheliaConfig.identity_providers = {};
    if (!autheliaConfig.identity_providers.oidc) autheliaConfig.identity_providers.oidc = {};
    autheliaConfig.identity_providers.oidc.clients = existingClients;

    const newConfig = yaml.dump(autheliaConfig, { lineWidth: -1, quotingType: "'", forceQuotes: false });
    // #1000 — configuration.yml is owned by Authelia's in-container UID
    // (~525287 on the FCoS layout). The `core` user that the agent runs
    // as can't write it directly → EACCES → the install-time OIDC
    // reconciler silently failed and SSO clients never got registered
    // (root cause for the live-box manifestation of #989). The agent's
    // write_file now accepts a `sudo` flag, same shape as #984/#992's
    // efibootmgr -n.
    await agent.sendCommand('write_file', {
      path: configFilePath,
      content: newConfig,
      sudo: true,
    });

    // Restart Authelia to pick up changes
    try {
      // Restarting the merged 'auth' pod restarts both authelia + lldap;
      // that's fine — the operation is fast and lldap re-attaches cleanly.
      await ServiceManager.restartService(autheliaNode, 'auth');
    } catch {
      // Non-fatal: config is written, restart can be done manually
    }

    return NextResponse.json({ added, skipped });
  } catch (error) {
    return apiError(error, { tag: 'api:system:authelia:oidc-clients', status: 500 });
  }
});
