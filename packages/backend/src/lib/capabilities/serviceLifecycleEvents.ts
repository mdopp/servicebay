/**
 * Capability events for the SINGLE-service lifecycle (#2541).
 *
 * Until now `bus.emit` for the uninstall events lived in exactly one
 * place — the stack-wipe route — so deleting one service left its
 * Authelia OIDC client, NPM proxy host, AdGuard rewrite, credentials
 * manifest entry and `blockLanAccess` firewall rule behind. An orphaned
 * OIDC client is a live login path and an orphaned proxy host points at a
 * port some other service will eventually take; that is not tidiness.
 *
 * `deleteService` is a **soft delete into the trash bin**, so the two
 * halves have to land together:
 *
 *   - delete  → `feature.uninstalling` (pre-stop) + `feature.uninstalled`
 *   - restore → `feature.installed`, which re-provisions all five
 *               neighbours through the same handlers the install path uses
 *
 * Shipping only the cleanup half would bring a restored service back
 * without SSO and without a proxy route — silently, exactly when the
 * operator is recovering from a mistake.
 *
 * ## Why the variable reconstruction lives here
 *
 * Every uninstall handler except `credentials` reads more than the
 * template name off the event:
 *
 *   - `nginx` needs `meta.type === 'subdomain'` + `meta.templateName` +
 *     `meta.proxyPort` to rebuild the `<sub>.<domain>` host list;
 *   - `adguard` needs the same plus `meta.exposure`;
 *   - `hostFirewall` layers the event values over the persisted ones;
 *   - `credentials` (install side) needs `meta.oidcClient.clientSecretVar`
 *     AND the secret's value.
 *
 * The wipe route's old `buildLastKnownVariables` produced bare
 * `{name, value}` pairs with **no `meta`**, so `buildProxyHosts` and
 * `rewriteNamesFor` both filtered everything out: the stack wipe's NPM and
 * AdGuard cleanup were silent no-ops. Reconstructing per template — the
 * declarations from `variables.json`, the values through the ONE read-path
 * resolver (#2544: `templateSettings` > operator-set `installedVariables`
 * (#2531) > declared default), the secrets from `installedSecrets` (#615) —
 * is what actually makes the handlers fire.
 *
 * Secrets ARE resolved here, unlike in `buildEffectiveVariableView`'s two
 * other callers: this map is handler input (the credentials manifest is
 * rebuilt from it), never a rendered operator-visible surface.
 */
import { getConfig } from '@/lib/config';
import { getTemplateVariables, getTemplateYaml, type VariableMeta } from '@/lib/registry';
import { parseTemplateManifest, type TemplateManifest } from '@/lib/template/contract';
import { buildEffectiveVariableView } from '@/lib/template/effectiveVariables';
import { loadSavedSecrets } from '@/lib/install/savedSecrets';
import {
  emitFeatureInstalledWithRetry,
  recordHandlerFailure,
  clearHandlerFailure,
} from '@/lib/install/handlerFailures';
import { logger } from '@/lib/logger';
import { getCapabilityBus } from './bus';
import type { StackVariable } from '@/lib/stackInstall/types';
import type { EmitResult } from './types';

const LOG_SCOPE = 'CapabilityLifecycle';

/** One handler that did not converge. Flat on purpose — callers log it,
 *  record it as a standing finding, or fold it into an API response. */
export interface CapabilityFailure {
  handler: string;
  message: string;
}

function toFailures(result: EmitResult): CapabilityFailure[] {
  return result.failures
    .filter(f => !f.result.ok)
    .map(f => ({ handler: f.handler, message: f.result.ok ? '' : f.result.message }));
}

/**
 * Log + persist the outcome of one lifecycle emit.
 *
 * A handler that could not converge leaves the box in a half-state — an
 * orphaned OIDC client after a delete, a restored service with no proxy
 * route — so it becomes a standing `install_handler_failed` finding with a
 * retry, exactly as the install runner does. A clean run clears any record
 * an earlier install left standing.
 */
export async function recordCapabilityOutcome(
  service: string,
  failures: CapabilityFailure[],
  what: string,
): Promise<void> {
  for (const f of failures) {
    logger.warn(LOG_SCOPE, `${f.handler} (${what} ${service}): ${f.message}`);
    await recordHandlerFailure({ kind: 'capability', service, message: `${f.handler}: ${f.message}` });
  }
  if (failures.length === 0) await clearHandlerFailure('capability', service);
}

/**
 * Reconstruct the variable set a template was installed with, as far as
 * durable state allows.
 *
 * Precedence per declared variable mirrors the install path exactly (it is
 * the same `buildEffectiveVariableView` the health probes and the host
 * firewall resolve through), with `installedSecrets` filling the
 * secret-typed declarations the read-path resolver deliberately refuses to
 * touch.
 *
 * **Known lossy edges** — a value that was never persisted cannot be
 * recovered, and this function does not pretend otherwise:
 *   - a non-secret variable the operator typed on an install that predates
 *     `installedVariables` (#2531) resolves to the template DEFAULT;
 *   - a template no longer present in the registry yields no declarations
 *     at all, so only globals + secrets come back.
 * Both degrade to "clean up / re-provision what the default would have
 * created", which is what the pre-#2531 install would have produced anyway.
 */
export async function reconstructTemplateVariables(template: string): Promise<StackVariable[]> {
  const config = await getConfig();
  const declarations = await getTemplateVariables(template).catch(() => null);
  const view = buildEffectiveVariableView(config, declarations);
  const secrets = loadSavedSecrets(config);

  const out: StackVariable[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string | undefined, meta?: VariableMeta) => {
    if (!name || !value || seen.has(name)) return;
    seen.add(name);
    out.push(meta ? { name, value, meta } : { name, value });
  };

  // Declared variables first, carrying their `meta` — without it the nginx
  // and adguard handlers have nothing to match on. `templateName` is
  // injected here for the same reason `assembleManifest` injects it: it is
  // the ownership key both handlers filter by (#1862).
  for (const [name, meta] of Object.entries(declarations ?? {})) {
    if (!meta) continue;
    push(name, view[name] ?? secrets[name], { ...meta, templateName: template });
  }
  // Globals the template doesn't declare but handlers read (PUBLIC_DOMAIN,
  // DATA_DIR, …). `view` already carries every `templateSettings` key.
  for (const [name, value] of Object.entries(view)) push(name, value);
  if (config.reverseProxy?.publicDomain) push('PUBLIC_DOMAIN', config.reverseProxy.publicDomain);
  for (const [name, value] of Object.entries(secrets)) push(name, value);

  return out;
}

/**
 * `feature.installed` needs a `TemplateManifest`. None of the five
 * handlers read it, so a service whose template.yml is missing or
 * unparseable still gets its neighbours re-provisioned off a minimal
 * stand-in rather than silently getting nothing.
 */
async function loadManifest(template: string): Promise<TemplateManifest> {
  const yamlText = await getTemplateYaml(template).catch(() => null);
  if (yamlText) {
    const parsed = parseTemplateManifest(yamlText);
    if (parsed.ok) return parsed.manifest;
    logger.warn(LOG_SCOPE, `template.yml for ${template} did not parse (${parsed.errors.join('; ')}); using a minimal manifest`);
  }
  return { label: template, tier: 'feature', schemaVersion: 1, dependencies: [] };
}

/**
 * Fire `feature.uninstalling` — the pre-stop hook, same position the wipe
 * route fires it from.
 *
 * **Kept, not dropped** (#2541 asked): it has zero subscribers today, but
 * it is the only seam a handler has to capture state that lives inside the
 * still-running unit, and the delete path is precisely where that matters
 * (the unit stops seconds later). Dropping it would remove the hook right
 * as a second caller for it appears. Both uninstall paths now fire it, so
 * a future subscriber sees one contract instead of two.
 */
export async function emitFeatureUninstalling(
  template: string,
  lastKnownVariables: StackVariable[],
): Promise<CapabilityFailure[]> {
  try {
    return toFailures(await getCapabilityBus().emit({ kind: 'feature.uninstalling', template, lastKnownVariables }));
  } catch (e) {
    return [{ handler: 'bus', message: `feature.uninstalling: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

/** Fire `feature.uninstalled` — cross-service cleanup for one template. */
export async function emitFeatureUninstalled(
  template: string,
  lastKnownVariables: StackVariable[],
): Promise<CapabilityFailure[]> {
  try {
    return toFailures(await getCapabilityBus().emit({ kind: 'feature.uninstalled', template, lastKnownVariables }));
  } catch (e) {
    return [{ handler: 'bus', message: `feature.uninstalled: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

/**
 * Fire `feature.installed` for a service coming back out of the trash —
 * the counterpart to the cleanup above. Uses the install runner's bounded
 * retry so a transient Authelia restart doesn't leave the restored service
 * without its OIDC client.
 */
export async function emitFeatureRestored(template: string): Promise<CapabilityFailure[]> {
  try {
    const variables = await reconstructTemplateVariables(template);
    const manifest = await loadManifest(template);
    const bus = getCapabilityBus();
    const result = await emitFeatureInstalledWithRetry({
      emit: () => bus.emit({ kind: 'feature.installed', template, manifest, variables }),
      onRetry: (attempt, count) =>
        logger.info(LOG_SCOPE, `Retrying ${count} recoverable handler failure(s) restoring ${template} (attempt ${attempt + 1})`),
    });
    return toFailures(result);
  } catch (e) {
    return [{ handler: 'bus', message: `feature.installed: ${e instanceof Error ? e.message : String(e)}` }];
  }
}
