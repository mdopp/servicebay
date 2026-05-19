/**
 * Credentials-manifest capability handler (#631 / Phase 4C).
 *
 * Append-on-install / strip-on-uninstall for `config.installManifest`.
 * Today the install runner builds the manifest at end-of-job and POSTs
 * it wholesale; this handler is the per-template seam #PH4D will
 * eventually replace that with.
 *
 * On install:
 *   - Builds the template's OIDC client_secret entries via
 *     `buildCredentialsManifest`.
 *   - Merges into the persisted `config.installManifest.credentials`,
 *     replacing any existing entries owned by the same template.
 *
 * On uninstall:
 *   - Removes entries whose `template` matches the uninstalled feature.
 *   - Legacy entries (no `template` field) are NEVER auto-removed —
 *     they predate Phase 4C and we can't reliably attribute them.
 *
 * Idempotency: re-emitting `feature.installed` with the same variables
 * yields the same credentials and replaces the in-place entries with
 * identical values. No duplicate accumulation.
 */
import { buildCredentialsManifest, type Credential } from '@/lib/stackInstall/credentialsManifest';
import { getConfig, saveConfig } from '@/lib/config';
import type { InstalledCredential, InstallManifest } from '@/lib/config';
import { logger } from '@/lib/logger';
import type { CapabilityBus } from './bus';
import type {
  FeatureInstalledEvent,
  FeatureUninstalledEvent,
  HandlerResult,
} from './types';

const HANDLER_NAME = 'credentials.manifest';

/** Per-process serialization. `saveConfig` already holds its own lock,
 *  but the credentials manifest is a "read-merge-write" pattern where
 *  two concurrent emits would both compute their merge off the same
 *  snapshot and one would clobber the other. */
let credentialsQueue: Promise<unknown> = Promise.resolve();
function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = credentialsQueue.then(fn, fn);
  credentialsQueue = next.catch(() => undefined);
  return next;
}

function toInstalledCredentials(creds: Credential[]): InstalledCredential[] {
  // The wire shape (`Credential`) and config shape (`InstalledCredential`)
  // are structurally identical today; the explicit cast plus an `as never`
  // for the optional fields keeps TS from widening the union.
  return creds as unknown as InstalledCredential[];
}

export async function handleInstalled(event: FeatureInstalledEvent): Promise<HandlerResult> {
  const generated = buildCredentialsManifest({ variables: event.variables });
  // Tag any entries the builder forgot (older code paths) with this
  // template so the uninstall handler can find them. The OIDC builder
  // already sets `template`; this is a belt-and-braces guard.
  const owned: Credential[] = generated.map(c => ({
    ...c,
    template: c.template ?? event.template,
  }));
  if (owned.length === 0) return { ok: true };

  try {
    await withCredentialsLock(async () => {
      const config = await getConfig();
      const existing = config.installManifest?.credentials ?? [];
      // Drop any prior entries owned by this template — they'll be
      // re-added below with current values. Foreign entries (other
      // templates, legacy untagged) are preserved.
      const filtered = existing.filter(c => (c as Credential).template !== event.template);
      const next: InstallManifest = {
        savedAt: new Date().toISOString(),
        credentials: [...filtered, ...toInstalledCredentials(owned)],
      };
      await saveConfig({ ...config, installManifest: next });
    });
    logger.info('CapabilityBus', `[${HANDLER_NAME}] Persisted ${owned.length} credential entry(ies) for ${event.template}.`);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      retryable: true,
      message: `credentials persist: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handleUninstalled(event: FeatureUninstalledEvent): Promise<HandlerResult> {
  try {
    let removed = 0;
    await withCredentialsLock(async () => {
      const config = await getConfig();
      const existing = config.installManifest?.credentials ?? [];
      if (existing.length === 0) return;
      const kept = existing.filter(c => (c as Credential).template !== event.template);
      removed = existing.length - kept.length;
      if (removed === 0) return;
      const next: InstallManifest = {
        savedAt: new Date().toISOString(),
        credentials: kept,
      };
      await saveConfig({ ...config, installManifest: next });
    });
    if (removed > 0) {
      logger.info('CapabilityBus', `[${HANDLER_NAME}] Removed ${removed} credential entry(ies) for ${event.template}.`);
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      retryable: true,
      message: `credentials remove: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function registerCredentialsHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
  bus.subscribe('feature.uninstalled', HANDLER_NAME, handleUninstalled);
}
