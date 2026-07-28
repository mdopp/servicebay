/**
 * Keep ServiceBay's own `config.oidc.clientSecret` equal to the secret
 * Authelia actually registered for the `servicebay` OIDC client (#2417).
 *
 * ## Why this module exists
 *
 * The `servicebay` client is the one guarding ServiceBay's admin panel:
 * "Login with Authelia" sends the user to Authelia, then the callback route
 * (`app/api/auth/oidc/callback/route.ts`) posts `client_secret` — read from
 * `config.oidc.clientSecret` — to Authelia's token endpoint. Authelia compares
 * it against the `client_secret` in its `configuration.yml` clients[] block.
 *
 * Until #2417 that block carried ONE hardcoded literal (`$plaintext$servicebay-
 * oidc-secret`) committed to the repo, identical on every install in the world.
 * It is now rendered from the per-install `SERVICEBAY_OIDC_SECRET` variable —
 * which means the value CHANGES on the upgrade deploy, and the two sides must
 * be brought back into agreement or the SSO button breaks with `invalid_client`.
 *
 * ## The design: follow the file, never lead it
 *
 * There is no transaction spanning "Authelia's configuration.yml on the box"
 * and "ServiceBay's config.json". Two stores, two writes — a crash in between
 * is always possible. So instead of trying to fake atomicity, this module makes
 * the drift window *harmless and self-closing*, by fixing the DIRECTION of the
 * dependency:
 *
 *   1. **Authelia's on-disk config is the authority.** We never push a secret
 *      into it from here. We READ the `servicebay` client's `client_secret`
 *      back out of the file that just landed and copy it into
 *      `config.oidc.clientSecret`. ServiceBay therefore cannot end up holding
 *      a secret Authelia has never heard of — the failure mode that produces a
 *      dead login button.
 *   2. **It runs AFTER the file is written and the pod restarted.** The install
 *      path treats `writeExtraConfigFiles` as fatal, so a deploy that dies
 *      before Authelia's config lands never reaches this reconcile: the box
 *      keeps its old, still-consistent pair and the SSO button keeps working.
 *      A failed deploy is a no-op, not a half-migration.
 *   3. **It is idempotent and re-runs on every `auth` deploy.** A crash in the
 *      window (config written, process dies before `updateConfig`) leaves a
 *      recoverable, non-sticky mismatch: redeploy `auth` and this reconcile
 *      re-reads the same file and converges. Nothing about the mismatch
 *      persists across a retry.
 *   4. **Break-glass, not lockout.** Even inside the window the operator is not
 *      locked out: `/login` renders a local username/password form
 *      (`/api/auth/login`, backed by `config.auth.passwordHash` or the
 *      `SERVICEBAY_PASSWORD` bootstrap env) that is entirely independent of
 *      OIDC. Only the SSO *button* is affected. `assertBreakGlassLogin` below
 *      is the pre-flight that refuses to rotate when that second door is
 *      missing.
 *
 * Same "reconcile, don't generate" shape as `reconcileHermesApiKey` (#1761) and
 * `resolveOidcClientSecret` (#1738): the value already in the authoritative
 * store wins, and we adopt it.
 *
 * SECURITY: the secret is read over the agent's `read_file` seam, stored under
 * `config.oidc.clientSecret` (matched by config.ts's `SENSITIVE_KEYS`, so
 * encrypted at rest) and is NEVER logged — only the outcome is.
 */
import yaml from 'js-yaml';

/** Authelia's marker for a client secret stored as cleartext. */
const PLAINTEXT_PREFIX = '$plaintext$';

/** The client_id of ServiceBay's own admin-panel OIDC client. */
export const SERVICEBAY_CLIENT_ID = 'servicebay';

/**
 * Pull the `servicebay` client's cleartext `client_secret` out of an Authelia
 * `configuration.yml`.
 *
 * Returns `null` — never throws — when the document can't be parsed, the client
 * isn't declared, or its secret is stored HASHED (`$pbkdf2…` / `$argon2…`). A
 * hash is one-way: it cannot be replayed as the value the token endpoint
 * expects, so there is nothing to adopt and the caller must leave
 * `config.oidc.clientSecret` alone rather than overwrite a working value with
 * a useless one.
 *
 * @param configYaml  the on-disk Authelia `configuration.yml` text.
 * @param clientId    client_id to look up (defaults to `servicebay`).
 */
export function extractServicebayClientSecret(
  configYaml: string | null | undefined,
  clientId: string = SERVICEBAY_CLIENT_ID,
): string | null {
  const client = readClients(configYaml).find(
    c => (c as Record<string, unknown>).client_id === clientId,
  );
  if (!client) return null;

  const secret = (client as Record<string, unknown>).client_secret;
  // A hash (`$pbkdf2…` / `$argon2…`) is one-way — nothing to adopt.
  if (typeof secret !== 'string' || !secret.startsWith(PLAINTEXT_PREFIX)) return null;
  return secret.slice(PLAINTEXT_PREFIX.length) || null;
}

/** `identity_providers.oidc.clients[]`, or `[]` for anything unparseable. */
function readClients(configYaml: string | null | undefined): Record<string, unknown>[] {
  if (!configYaml || !configYaml.trim()) return [];
  let doc: unknown;
  try {
    doc = yaml.load(configYaml);
  } catch {
    return [];
  }
  const idp = asRecord(doc)?.identity_providers;
  const oidc = asRecord(idp)?.oidc;
  const clients = asRecord(oidc)?.clients;
  if (!Array.isArray(clients)) return [];
  return clients.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Outcome of one reconcile pass. `secret` is deliberately NOT included. */
export type OidcSecretOutcome = 'aligned' | 'changed' | 'skipped';

export interface OidcSecretReconcileResult {
  outcome: OidcSecretOutcome;
  /** Operator-facing, secret-free. Safe to write to the install log. */
  message: string;
}

/**
 * Decide what `config.oidc` should become, given the secret Authelia holds.
 * Pure, so the whole decision table is unit-tested without touching config.
 *
 * Rules:
 *   - No secret readable from Authelia's config → `skipped`, change nothing.
 *   - `config.oidc.clientSecret` already equals it → `aligned`, no write.
 *   - Otherwise → `changed`, with the next `oidc` object to persist.
 *
 * `enabled` is NEVER flipped here. Whether the admin panel offers SSO at all is
 * the operator's decision (the `/login` page shows the SSO button only when
 * `oidc.enabled`); this reconcile only guarantees that IF it is enabled, the
 * secret it posts is the one Authelia will accept. On a box where `oidc` does
 * not exist yet we still record the secret (with `enabled: false`) so turning
 * SSO on later is a single toggle and never a "now go find the secret" hunt.
 */
export function decideOidcSecretUpdate(
  currentOidc: { enabled: boolean; issuer: string; clientId: string; clientSecret: string; allowedGroups?: string[] } | undefined,
  autheliaSecret: string | null,
): { result: OidcSecretReconcileResult; next?: NonNullable<typeof currentOidc> } {
  if (!autheliaSecret) {
    return {
      result: {
        outcome: 'skipped',
        message:
          "Could not read the `servicebay` OIDC client secret out of Authelia's configuration.yml (client absent, or its secret is hashed rather than $plaintext$). Left ServiceBay's config.oidc.clientSecret untouched — an unreadable file must never overwrite a working value.",
      },
    };
  }

  if (currentOidc && currentOidc.clientSecret === autheliaSecret) {
    return {
      result: {
        outcome: 'aligned',
        message: "ServiceBay's admin-panel OIDC client secret already matches Authelia's `servicebay` client.",
      },
    };
  }

  const next = {
    enabled: currentOidc?.enabled ?? false,
    issuer: currentOidc?.issuer ?? '',
    clientId: currentOidc?.clientId || SERVICEBAY_CLIENT_ID,
    clientSecret: autheliaSecret,
    ...(currentOidc?.allowedGroups ? { allowedGroups: currentOidc.allowedGroups } : {}),
  };

  return {
    result: {
      outcome: 'changed',
      message: currentOidc
        ? "Adopted Authelia's `servicebay` OIDC client secret into ServiceBay's config.oidc.clientSecret — the admin panel's \"Login with Authelia\" button now posts the secret Authelia expects."
        : "Recorded Authelia's `servicebay` OIDC client secret in config.oidc.clientSecret (admin-panel SSO stays disabled until you enable it in Settings).",
    },
    next,
  };
}

/**
 * Pre-flight for the one deliberate secret rotation this platform performs.
 *
 * `mergeAutheliaOidcClients` never rotates an already-registered client's
 * secret — that stickiness is the #1559/#1738 invariant. The `servicebay`
 * client is the deliberate exception: the fresh render owns it, so the #2417
 * upgrade deploy replaces the hardcoded literal with the per-box value. That
 * rotation briefly desynchronises the admin panel's SSO button.
 *
 * That is acceptable ONLY because a second, non-OIDC way into the admin panel
 * exists. This asserts it. If the box has neither a stored password hash nor
 * the `SERVICEBAY_PASSWORD` bootstrap env, SSO is the operator's ONLY door and
 * a mid-rotation crash would be a genuine lockout — so the caller aborts the
 * deploy BEFORE anything is written, and the box keeps its (consistent, if
 * publicly-known) old secret until the operator sets an admin password.
 *
 * Pure: takes what it needs so the decision is unit-tested directly.
 *
 * @returns `null` when a break-glass login exists, otherwise the operator-facing
 *          reason the rotation must not proceed.
 */
export function assertBreakGlassLogin(
  passwordHash: string | undefined,
  bootstrapPassword: string | undefined,
): string | null {
  if (passwordHash || bootstrapPassword) return null;
  return (
    'Refusing to rotate the `servicebay` Authelia OIDC client secret: this box has no local admin password ' +
    '(config.auth.passwordHash is unset and SERVICEBAY_PASSWORD is not in the environment), so "Login with Authelia" ' +
    'is the ONLY way into the admin panel. Rotating the secret would leave no second door if the rotation is ' +
    'interrupted. Set an admin username + password first (Settings → Access, or SERVICEBAY_PASSWORD on the container) ' +
    'and redeploy `auth` — the rotation will then proceed automatically (#2417).'
  );
}

/**
 * `true` when writing `renderedConfig` over `existingConfig` would CHANGE the
 * `servicebay` client's secret. Pure.
 *
 * A fresh install (nothing on disk) is not a rotation — there is no working
 * login to break. Neither is a redeploy that renders the same value, which is
 * the steady state once `SERVICEBAY_OIDC_SECRET` is stored in
 * `config.installedSecrets` and reused on every subsequent deploy.
 */
export function isServicebaySecretRotation(
  renderedConfig: string,
  existingConfig: string | null | undefined,
): boolean {
  const before = extractServicebayClientSecret(existingConfig);
  if (!before) return false; // fresh install / unreadable / hashed — nothing to lose
  const after = extractServicebayClientSecret(renderedConfig);
  if (!after) return false; // the render doesn't own the client — merge preserves the old one
  return before !== after;
}

/** Path of the Authelia config among a deploy's rendered `extraFiles`, if any. */
function findAutheliaConfigPath(extraFiles: { path: string }[]): string | undefined {
  return extraFiles.find(f => f.path.endsWith('configuration.yml'))?.path;
}

/**
 * Deploy-time guard (#2417). Throws — aborting the `auth` deploy BEFORE any file
 * is written — when this deploy would rotate the `servicebay` client secret on a
 * box that has no non-OIDC way into the admin panel. See `assertBreakGlassLogin`.
 *
 * No-ops for every non-`auth` deploy, for fresh installs, and for the steady
 * state where the rendered secret already matches what is on disk.
 *
 * @param existingConfig  the on-disk Authelia config read by the caller (so this
 *                        costs no extra round-trip), or null on a fresh install.
 */
export async function assertServicebayOidcRotationSafe(
  extraFiles: { path: string; content: string }[],
  existingConfig: string | null,
): Promise<void> {
  const cf = extraFiles.find(f => f.path.endsWith('configuration.yml'));
  if (!cf) return; // not the auth stack
  if (!isServicebaySecretRotation(cf.content, existingConfig)) return;

  const { getConfig } = await import('@/lib/config');
  const config = await getConfig();
  const reason = assertBreakGlassLogin(config.auth?.passwordHash, process.env.SERVICEBAY_PASSWORD);
  if (reason) throw new Error(reason);
}

/**
 * Post-deploy reconcile (#2417): adopt the `servicebay` client secret that is
 * NOW on disk into `config.oidc.clientSecret`.
 *
 * Call this only after the deploy reported success, so a deploy that never got
 * as far as writing Authelia's config leaves the box's (consistent) old pair
 * alone — see the module header for why the ordering matters. No-ops for every
 * stack other than `auth`.
 *
 * Best-effort by contract: never throws. A failure here is a recoverable,
 * non-sticky mismatch (redeploy `auth` and it converges) that at worst disables
 * the SSO button while the local password login keeps working.
 */
export async function reconcileServicebayOidcSecret(
  node: string | undefined,
  extraFiles: { path: string; content: string }[],
): Promise<OidcSecretReconcileResult | null> {
  const configPath = findAutheliaConfigPath(extraFiles);
  if (!configPath) return null; // not the auth stack

  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(node || 'Local');
    const readRes = await agent.sendCommand('read_file', { path: configPath }).catch(() => null);
    const onDisk = readRes ? (readRes.content || readRes.stdout || '') : '';

    const secret = extractServicebayClientSecret(onDisk);
    const { getConfig, updateConfig } = await import('@/lib/config');
    const config = await getConfig();
    const { result, next } = decideOidcSecretUpdate(config.oidc, secret);
    if (next) await updateConfig({ oidc: next });
    return result;
  } catch (e) {
    return {
      outcome: 'skipped',
      message:
        `Could not reconcile ServiceBay's admin-panel OIDC client secret against Authelia's config ` +
        `(${e instanceof Error ? e.message : String(e)}). If "Login with Authelia" fails with an invalid-client ` +
        `error, log in with the local admin username/password and redeploy \`auth\` — the reconcile is idempotent ` +
        `and converges on the next run (#2417).`,
    };
  }
}
