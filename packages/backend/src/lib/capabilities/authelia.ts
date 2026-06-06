/**
 * Authelia capability handler (#630 / Phase 4B).
 *
 * Subscribes to:
 *   - `feature.installed`   → registers the template's OIDC client(s)
 *                              with Authelia via POST.
 *   - `feature.uninstalled` → removes those same client(s) via DELETE.
 *
 * The OIDC client list is derived from the template's `variables.json`
 * (the `oidcClient` field on `subdomain`-typed variables) — no extra
 * state is persisted to track "what we registered." That's option (a)
 * from the issue: metadata is the source of truth, so install and
 * uninstall always see the same client_id set without a side-store.
 *
 * The install path is a thin wrapper over the existing
 * `POST /api/system/authelia/oidc-clients` endpoint (which is already
 * idempotent — it skips client_ids that already exist). The uninstall
 * path uses the new `DELETE /api/system/authelia/oidc-clients/[client_id]`
 * route added in this same PR.
 *
 * Handler results:
 *   - Authelia not deployed (404) → `{ ok: true }` — common during a
 *     first install when Authelia hasn't been installed yet. Phase 5's
 *     tier gate refuses feature installs when core is degraded; until
 *     then we degrade gracefully.
 *   - Network / 5xx → `{ ok: false, retryable: true, message }` so the
 *     bus surfaces a diagnose finding the operator can retry.
 *   - Non-retryable failure modes don't exist for this handler — every
 *     remote-side issue is potentially transient.
 */
import { getTemplateVariables } from '@/lib/registry';
import { logger } from '@/lib/logger';
import { internalFetch } from '@/lib/api/internalFetch';
import type { CapabilityBus } from './bus';
import type {
  FeatureInstalledEvent,
  FeatureUninstalledEvent,
  HandlerResult,
} from './types';

const HANDLER_NAME = 'authelia.oidc';

/**
 * Walk the template's `variables.json` and return the `client_id`s for
 * every `subdomain`+`oidcClient` declaration. Used by both install and
 * uninstall so the two paths always agree on what to do.
 */
async function listOidcClientIds(template: string): Promise<string[]> {
  const meta = await getTemplateVariables(template).catch(() => null);
  if (!meta) return [];
  const ids: string[] = [];
  for (const [, varMeta] of Object.entries(meta)) {
    const oidc = varMeta.oidcClient;
    if (!oidc?.client_id) continue;
    if (varMeta.type !== 'subdomain') continue;
    ids.push(oidc.client_id);
  }
  return ids;
}

/**
 * ADR 0009 Phase 2 (#1741) — build the `templates[] + variables` payload for a
 * standalone OIDC reconcile triggered by the `sso_verify` diagnose heal-action.
 *
 * Unlike the install path (which receives the live `StackVariable[]` from the
 * job), an on-demand reconcile has no job context — it must reconstruct the
 * payload from durable state:
 *   - `PUBLIC_DOMAIN` ← `config.reverseProxy.publicDomain` (the apex the wizard
 *     persisted; without it there are no OIDC clients to reconcile).
 *   - each subdomain value ← the template's `variables.json` `default`. Subdomain
 *     overrides aren't persisted anywhere readable post-install, and the default
 *     is the canonical value every OIDC client was registered against; the POST
 *     endpoint is reconcile-first and skips already-registered client_ids, so a
 *     stale subdomain just no-ops on the existing client (never rotates a secret).
 *
 * Returns `null` when there's nothing to reconcile (no public domain, or no
 * installed template declares an OIDC client) so the caller can short-circuit.
 */
export async function buildOidcReconcilePayload(opts: {
  installedTemplates: string[];
  publicDomain: string | undefined;
}): Promise<{ templates: { name: string }[]; variables: Record<string, string> } | null> {
  if (!opts.publicDomain) return null;
  const variables: Record<string, string> = { PUBLIC_DOMAIN: opts.publicDomain };
  const templates: { name: string }[] = [];
  for (const name of opts.installedTemplates) {
    const meta = await getTemplateVariables(name).catch(() => null);
    if (!meta) continue;
    let hasOidc = false;
    for (const [varName, varMeta] of Object.entries(meta)) {
      if (varMeta.type !== 'subdomain' || !varMeta.oidcClient?.client_id) continue;
      hasOidc = true;
      if (varMeta.default) variables[varName] = varMeta.default;
    }
    if (hasOidc) templates.push({ name });
  }
  if (templates.length === 0) return null;
  return { templates, variables };
}

export async function handleInstalled(event: FeatureInstalledEvent): Promise<HandlerResult> {
  const ids = await listOidcClientIds(event.template);
  if (ids.length === 0) return { ok: true };

  // Existing endpoint accepts a templates[] + variables map; we pass
  // exactly the one template at hand. The endpoint already de-dupes by
  // client_id, so re-emitting `feature.installed` is a no-op server-side.
  const variableMap = event.variables.reduce<Record<string, string>>((acc, v) => {
    acc[v.name] = v.value;
    return acc;
  }, {});
  if (!variableMap.PUBLIC_DOMAIN) return { ok: true }; // LAN-only install — no OIDC

  try {
    const res = await internalFetch('/api/system/authelia/oidc-clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templates: [{ name: event.template }],
        variables: variableMap,
      }),
    });
    if (res.status === 404) {
      // Authelia not deployed yet — common during the first install of a
      // SSO-enabled feature before the auth stack is up. Surface a soft
      // warning rather than failing; the operator-visible message comes
      // from diagnose's existing "no OIDC client" probe.
      logger.info('CapabilityBus', `[${HANDLER_NAME}] Authelia not deployed; skipping client registration for ${event.template}.`);
      return { ok: true };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      return { ok: false, retryable: true, message: `OIDC register: ${message}` };
    }
    const data = await res.json().catch(() => ({}));
    const added: string[] = Array.isArray(data.added) ? data.added : [];
    const skipped: string[] = Array.isArray(data.skipped) ? data.skipped : [];
    if (added.length > 0) logger.info('CapabilityBus', `[${HANDLER_NAME}] Registered OIDC client(s) for ${event.template}: ${added.join(', ')}`);
    if (skipped.length > 0) logger.debug?.('CapabilityBus', `[${HANDLER_NAME}] Skipped (already registered): ${skipped.join(', ')}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, retryable: true, message: `OIDC register: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function handleUninstalled(event: FeatureUninstalledEvent): Promise<HandlerResult> {
  const ids = await listOidcClientIds(event.template);
  if (ids.length === 0) return { ok: true };

  // Per-client DELETE. We continue past failures so a transient error on
  // one client doesn't strand siblings; failures aggregate into the
  // handler result.
  const failures: string[] = [];
  for (const id of ids) {
    try {
      const res = await internalFetch(
        `/api/system/authelia/oidc-clients/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      // 404 here means "already gone" — exactly what uninstall wants.
      if (res.ok || res.status === 404) {
        logger.info('CapabilityBus', `[${HANDLER_NAME}] Removed OIDC client ${id} for ${event.template} (status ${res.status}).`);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      failures.push(`${id}: ${message}`);
    } catch (e) {
      failures.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (failures.length === 0) return { ok: true };
  return {
    ok: false,
    retryable: true,
    message: `OIDC unregister: ${failures.join('; ')}`,
  };
}

export function registerAutheliaHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
  bus.subscribe('feature.uninstalled', HANDLER_NAME, handleUninstalled);
}
