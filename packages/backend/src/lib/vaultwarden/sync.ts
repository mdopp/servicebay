/**
 * Push ServiceBay's credential manifest into the Vaultwarden organization
 * collection, and drop the local copy of everything that landed (#2519).
 *
 * The contract, in order of importance:
 *
 *  1. **A local password is dropped only after the item was read back out
 *     of the vault and decrypted.** `upsert` returning 2xx is not enough
 *     — `verify` re-fetches the cipher and compares the decrypted name /
 *     username / password. Anything less would mean "we deleted your only
 *     copy because a proxy said 200".
 *  2. **Partial success is normal and is represented honestly.** Entries
 *     are confirmed one at a time; the ones that failed keep their
 *     password and stay "not yet secured" while their neighbours are
 *     secured.
 *  3. **Every not-ok path leaves the entries unsecured** — not
 *     configured, Vaultwarden not installed, unreachable, wrong password,
 *     org not shared with the ServiceBay account, or a read-back that did
 *     not match. The reason is persisted so Settings can say which.
 *
 * Provisioning (the ServiceBay account, the organization, the collection)
 * is an **operator setup step**, not something ServiceBay does for
 * itself: registering an account requires open signups, and putting the
 * *operator* into the organization afterwards needs an invitation they
 * accept with their own keys — a flow no server-side automation can
 * complete. ServiceBay silently creating an org it alone can read would
 * produce a vault the humans can't see, which is the failure mode this
 * issue is fixing. Recipe:
 * `assists/recipe-vaultwarden-servicebay-push.md`. Until it is done, this
 * module returns `not_configured` and the UI says so.
 */
import { getConfig, saveConfig, type AppConfig, type CredentialVaultSyncState, type InstalledCredential, type InstallManifest } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getTemplateVariables } from '@/lib/registry';
import { withCredentialsLock } from '@/lib/stackInstall/credentialsLock';
import {
  credentialKey,
  isCredentialSecured,
  markCredentialsSecuredByKey,
  resolveCredentialUrl,
  isHttpUrl,
  type Credential,
} from '@/lib/stackInstall/credentialsManifest';
import { resolveEffectiveVariable } from '@/lib/template/effectiveVariables';
import { connectVault, VaultwardenError, type VaultConnection, type VaultFailureReason, type VaultItem } from './client';

/** Template that declares the vault's host port. */
const VAULTWARDEN_TEMPLATE = 'vaultwarden';
const VAULTWARDEN_PORT_VAR = 'VAULTWARDEN_PORT';
/** Last resort only — used when the template's `variables.json` cannot be
 *  read at all. The declared default is read from the template so a bump
 *  there can't drift away from this client (the #2551 lesson). */
const FALLBACK_VAULTWARDEN_PORT = '8222';

export interface VaultSyncResult {
  ok: boolean;
  reason?: VaultFailureReason;
  message?: string;
  /** Entries this run tried to push. */
  attempted: number;
  /** Entries confirmed present in the vault and dropped locally. */
  secured: number;
  at: string;
}

/**
 * Candidate base URLs for the box's own Vaultwarden.
 *
 * ADR 0007 Decision 3: an isolated consumer addresses a sibling as
 * `host.containers.internal:<hostPort>` — never a hardcoded IP, never
 * `LAN_IP`, and never the public domain (that would send a
 * machine-to-machine call out through NPM and Authelia). The loopback
 * candidate covers a ServiceBay running in the host netns, where the
 * podman-injected name does not resolve.
 */
export async function resolveVaultBaseUrls(config: AppConfig, override?: string): Promise<string[]> {
  if (override) return [override.replace(/\/+$/, '')];
  const declarations = await getTemplateVariables(VAULTWARDEN_TEMPLATE).catch(() => null);
  const port = resolveEffectiveVariable(config, declarations, VAULTWARDEN_PORT_VAR) || FALLBACK_VAULTWARDEN_PORT;
  return [`http://host.containers.internal:${port}`, `http://127.0.0.1:${port}`];
}

/** True when the box has a Vaultwarden to push to at all. */
export function isVaultwardenInstalled(config: AppConfig): boolean {
  return Boolean(config.installedTemplates?.[VAULTWARDEN_TEMPLATE]);
}

/** Build the vault item for a credential entry. */
export function toVaultItem(cred: Credential, config: AppConfig): VaultItem {
  const hosts = (config.reverseProxy?.hosts ?? []).map(h => ({ domain: h.domain, service: h.service }));
  const url = resolveCredentialUrl(cred, { hosts, publicDomain: config.reverseProxy?.publicDomain });
  const provenance = `Written by ServiceBay${cred.template ? ` (template: ${cred.template})` : ''}.`;
  const notes = [cred.notes, cred.importance === 'system' ? '[system / disaster recovery]' : '', provenance]
    .filter(Boolean)
    .join('\n');
  return {
    key: credentialKey(cred),
    name: cred.service,
    username: cred.username,
    password: cred.password,
    uri: isHttpUrl(url) ? url : undefined,
    notes,
  };
}

/**
 * The connection, or a plain-language reason there isn't one. A string
 * result is a *state* the UI renders — never a thrown error.
 */
async function resolveConnection(config: AppConfig): Promise<VaultConnection | string> {
  if (!isVaultwardenInstalled(config)) {
    return 'Vaultwarden is not installed on this box, so there is nowhere to push these credentials.';
  }
  const v = config.credentialVault;
  if (!v?.accountEmail || !v.password || !v.organizationId || !v.collectionId) {
    return 'No ServiceBay Vaultwarden account is configured — see the "Push to Vaultwarden" setup step.';
  }
  const baseUrls = await resolveVaultBaseUrls(config, v.baseUrl);
  return {
    baseUrls,
    email: v.accountEmail,
    password: v.password,
    organizationId: v.organizationId,
    collectionId: v.collectionId,
  };
}

/** Entries ServiceBay still holds a secret for — the push worklist. */
export function pendingCredentials(config: AppConfig): Credential[] {
  const creds = (config.installManifest?.credentials ?? []) as Credential[];
  return creds.filter(c => !isCredentialSecured(c) && Boolean(c.password));
}

async function recordOutcome(state: CredentialVaultSyncState, securedKeys: ReadonlySet<string>): Promise<void> {
  await withCredentialsLock(async () => {
    const fresh = await getConfig();
    // Nothing to secure and no vault block to annotate ⇒ nothing to
    // write. A box that never set this up must not accrue a config write
    // per install just to record "still not set up" — the UI derives
    // that from the absent `credentialVault` itself.
    if (securedKeys.size === 0 && !fresh.credentialVault) return;
    let manifest: InstallManifest | undefined = fresh.installManifest;
    if (manifest && securedKeys.size > 0) {
      const next = markCredentialsSecuredByKey(manifest.credentials as Credential[], securedKeys, state.at);
      manifest = { savedAt: state.at, credentials: next as unknown as InstalledCredential[] };
    }
    const vault = fresh.credentialVault;
    await saveConfig({
      ...fresh,
      ...(manifest ? { installManifest: manifest } : {}),
      ...(vault ? { credentialVault: { ...vault, lastSync: state } } : {}),
    });
  });
}

function failure(reason: VaultFailureReason, message: string, attempted: number, at: string): VaultSyncResult {
  return { ok: false, reason, message, attempted, secured: 0, at };
}

interface PushFailure {
  reason: VaultFailureReason;
  message: string;
}

/**
 * Push each pending entry and collect the keys the vault CONFIRMED.
 *
 * Per-entry try/catch on purpose: one entry the vault chokes on must not
 * strand its neighbours, and it must not be silently counted as secured
 * either — it simply stays out of `securedKeys`.
 */
async function pushAll(
  session: { upsert: (i: VaultItem) => Promise<{ id: string; created: boolean }>; verify: (id: string, i: VaultItem) => Promise<boolean> },
  pending: readonly Credential[],
  config: AppConfig,
  trigger: string,
): Promise<{ securedKeys: Set<string>; firstFailure: PushFailure | null }> {
  const securedKeys = new Set<string>();
  let firstFailure: PushFailure | null = null;
  for (const cred of pending) {
    const item = toVaultItem(cred, config);
    try {
      const { id, created } = await session.upsert(item);
      if (!(await session.verify(id, item))) {
        firstFailure ??= {
          reason: 'verify_failed',
          message: `"${cred.service}" was accepted by Vaultwarden but could not be read back — ServiceBay kept its copy.`,
        };
        continue;
      }
      securedKeys.add(item.key);
      logger.info('Vaultwarden', `${created ? 'created' : 'updated'} vault item for ${cred.service} (${trigger}).`);
    } catch (e) {
      firstFailure ??= {
        reason: e instanceof VaultwardenError ? e.reason : 'push_failed',
        message: `"${cred.service}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { securedKeys, firstFailure };
}

/**
 * Push every not-yet-secured credential, then drop the local copy of the
 * ones the vault confirmed.
 *
 * Never throws: an install must not fail because a password manager was
 * down. The failure is *recorded* instead, and the entries stay unsecured
 * — visibly, in Settings.
 */
export async function syncCredentialsToVault(opts: { trigger?: string } = {}): Promise<VaultSyncResult> {
  const at = new Date().toISOString();
  const trigger = opts.trigger ?? 'manual';
  const config = await getConfig();
  const pending = pendingCredentials(config);
  if (pending.length === 0) return { ok: true, attempted: 0, secured: 0, at };

  const conn = await resolveConnection(config);
  if (typeof conn === 'string') {
    // Not set up / nothing installed — a state, not an error. Recorded
    // only when there is a vault block to record it in.
    await recordOutcome({ at, ok: false, reason: 'not_configured', message: conn, attempted: pending.length, secured: 0 }, new Set())
      .catch(() => undefined);
    return failure('not_configured', conn, pending.length, at);
  }

  let outcome: { securedKeys: Set<string>; firstFailure: PushFailure | null };
  try {
    outcome = await pushAll(await connectVault(conn), pending, config, trigger);
  } catch (e) {
    const reason = e instanceof VaultwardenError ? e.reason : 'push_failed';
    const message = e instanceof Error ? e.message : String(e);
    await recordOutcome({ at, ok: false, reason, message, attempted: pending.length, secured: 0 }, new Set())
      .catch(() => undefined);
    logger.warn('Vaultwarden', `credential push (${trigger}) failed: ${reason} — ${message}`);
    return failure(reason, message, pending.length, at);
  }

  const { securedKeys, firstFailure } = outcome;
  const ok = securedKeys.size === pending.length;
  const state: CredentialVaultSyncState = {
    at,
    ok,
    reason: ok ? undefined : firstFailure?.reason,
    message: ok ? undefined : firstFailure?.message,
    attempted: pending.length,
    secured: securedKeys.size,
  };
  await recordOutcome(state, securedKeys).catch(e => {
    logger.error('Vaultwarden', `could not persist the push outcome: ${e instanceof Error ? e.message : String(e)}`);
  });
  logger.info('Vaultwarden', `credential push (${trigger}): ${securedKeys.size}/${pending.length} secured.`);
  return {
    ok,
    reason: state.reason as VaultFailureReason | undefined,
    message: state.message,
    attempted: pending.length,
    secured: securedKeys.size,
    at,
  };
}
