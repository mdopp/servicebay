/**
 * Service-health bootstrap (#626 / Phase 3A).
 *
 * Discovers which deployed services ship a `servicebay.healthcheck`
 * annotation and registers each one with the `ServiceHealthPoller`.
 *
 * ## Which manifest the probe target comes from (#2656)
 *
 * **The pod YAML that is actually deployed on the node, not the current
 * template.** Up to #2656 this module only ever read
 * `getTemplateYaml(svc.name)` and re-rendered its annotation against the
 * *current* config — i.e. it probed DESIRED state while the operator was
 * looking at a tile describing RUNNING state. Any drift between the two
 * produced a permanent, unexplained `ready: false / "fetch failed"`:
 *
 *   - the reported case: a service deployed with
 *     `url: http://localhost:8701/healthz` while its template had since moved
 *     to `http://localhost:{{PORT}}/healthz` with a `default: "8700"`. Nothing
 *     listens on 8700, so every tick was ECONNREFUSED — with the annotated URL
 *     answering `200` the whole time, which is what made it unfalsifiable;
 *   - the same shape from the other direction: a template that bumps a port
 *     (or a variable snapshot that moves) between deploys.
 *
 * The deployed YAML is already fully rendered, so this path needs no variable
 * view at all — which removes the variable-snapshot half of the drift by
 * construction. The template path stays as the fallback for a service whose
 * on-disk YAML the twin hasn't got (a `.container` unit, a node that has not
 * reported its files yet).
 *
 * Nothing here reconciles anything (ADR 0012 — no autonomous repair): when the
 * two manifests disagree the divergence is *logged* and the deployed target is
 * probed. Converging them is a redeploy, which rewrites the pod YAML from the
 * current template and is then picked up by the re-bootstrap in the install
 * runner's post-deploy phase.
 *
 * Re-running this is idempotent — `ServiceHealthPoller.register()`
 * replaces existing entries by key. Phase 3B will hook in service
 * deploy / wipe events from the capability bus so re-bootstrap isn't
 * needed; for now, restart the server to pick up newly-deployed
 * services.
 */
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { readManifestAnnotations } from '@/lib/template/contract';
import { renderTemplate } from '@/lib/template/render';
import { buildEffectiveVariableView } from '@/lib/template/effectiveVariables';
import { getConfig } from '@/lib/config';
import { getNodeTwin } from '@/lib/store/repository';
import { logger } from '@/lib/logger';
import { parseHealthcheckYaml, type HealthcheckConfig } from './serviceHealthcheck';
import { getServiceHealthPoller } from './serviceHealth';

/**
 * Build the variable view used to render a healthcheck annotation.
 *
 * Resolution is NOT done here — it goes through the shared
 * {@link buildEffectiveVariableView}, the same precedence the install path
 * uses (`templateSettings` > operator-set value > template default).
 *
 * #2544: this used to be a private `defaults, then Object.assign(
 * templateSettings)` chain that never read `config.installedVariables`
 * (#2531). A port the operator changed in Configure lives only in that
 * store, so the poller probed the template's DEFAULT port instead of the
 * one the service actually listens on — a healthy service reported
 * unhealthy forever, with no clue why.
 *
 * Secrets are deliberately not resolvable here (see the module docs on the
 * resolver): a probe URL is not a place for credential material.
 *
 * Only reached for a service whose DEPLOYED pod YAML could not be read
 * (#2656) — the deployed manifest is already rendered and needs no view.
 */
async function buildVariableView(templateName: string): Promise<Record<string, string>> {
  const meta = await getTemplateVariables(templateName).catch(() => null);
  // Config unreadable → an EMPTY config view, which resolves to
  // defaults-only through the same function. Deliberately not a separate
  // defaults-only branch: a second code path is how this bug class starts.
  const cfg = await getConfig().catch(() => null);
  return buildEffectiveVariableView(cfg ?? {}, meta);
}

/** What a probe actually connects to — used to describe a drift in one line. */
function probeTarget(config: HealthcheckConfig): string {
  return config.kind === 'tcp' ? `${config.host}:${config.port}` : String(config.url);
}

/**
 * The pod YAML this node is RUNNING for `svc`, out of the node twin's watched
 * file set (the same source `listServices` parses, so no agent round-trip).
 * Null when the service has no separate pod spec (a `.container` Quadlet) or
 * the twin holds no content for it.
 */
function readDeployedPodYaml(nodeName: string, yamlPath: string | null | undefined): string | null {
  if (!yamlPath) return null;
  const files = getNodeTwin(nodeName)?.files;
  if (!files) return null;
  const exact = files[yamlPath]?.content;
  if (exact) return exact;
  // Same suffix fallback `listServices` uses: the twin may key the file by a
  // differently-rooted absolute path than the one the listing computed.
  const basename = yamlPath.split('/').pop();
  if (!basename) return null;
  const hit = Object.keys(files).find(p => p.endsWith(`/${basename}`) || p === basename);
  return hit ? (files[hit].content ?? null) : null;
}

/**
 * The healthcheck the DEPLOYED manifest declares, or null when it declares
 * none / can't be parsed. Never throws: an unreadable deployed manifest must
 * fall back to the template path, not lose the service's health tile.
 */
function deployedHealthcheck(
  nodeName: string,
  svc: { name: string; yamlPath?: string | null },
): HealthcheckConfig | null {
  let raw: string | undefined;
  try {
    const yamlText = readDeployedPodYaml(nodeName, svc.yamlPath);
    if (!yamlText) return null;
    raw = readManifestAnnotations(yamlText).healthcheckRaw;
  } catch (e) {
    logger.debug('ServiceHealth', `bootstrap: could not read the deployed manifest for ${svc.name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!raw) return null;
  // Strict: a deployed manifest is rendered, so a surviving `{{VAR}}` means
  // this file is not the thing to probe — fall back to the template.
  const parsed = parseHealthcheckYaml(raw, { permissive: false });
  if (!parsed.ok) {
    logger.warn('ServiceHealth', `bootstrap: ${svc.name} — the deployed manifest's healthcheck annotation is invalid (${parsed.errors.join('; ')}); falling back to the template.`);
    return null;
  }
  return parsed.config;
}

/**
 * The healthcheck the CURRENT template declares, rendered against the current
 * variable view. The fallback source, and the comparison side that makes a
 * drift visible.
 */
async function templateHealthcheck(serviceName: string): Promise<HealthcheckConfig | null> {
  // The service `name` matches the template directory name for stack
  // services. Non-stack services (raw Quadlet drops) won't resolve.
  const yamlText = await getTemplateYaml(serviceName).catch(() => null);
  if (!yamlText) return null;
  const raw = readManifestAnnotations(yamlText).healthcheckRaw;
  if (!raw) return null;

  // Render `{{VAR}}` placeholders against template defaults + operator
  // overrides. Goes through the canonical renderer (#599) so HTML
  // escaping is uniformly disabled — annotations are YAML.
  const view = await buildVariableView(serviceName);
  const resolved = renderTemplate(raw, view);

  // Strict re-parse: runtime needs concrete values, no placeholders.
  const parsed = parseHealthcheckYaml(resolved, { permissive: false });
  if (!parsed.ok) {
    logger.warn('ServiceHealth', `bootstrap: skipping ${serviceName} — invalid healthcheck annotation: ${parsed.errors.join('; ')}`);
    return null;
  }
  return parsed.config;
}

export async function bootstrapServiceHealth(nodeName: string = 'Local'): Promise<{ registered: string[]; skipped: string[] }> {
  const poller = getServiceHealthPoller();
  const registered: string[] = [];
  const skipped: string[] = [];

  let services;
  try {
    services = await ServiceManager.listServices(nodeName);
  } catch (e) {
    logger.warn('ServiceHealth', `bootstrap: failed to list services on ${nodeName}: ${e instanceof Error ? e.message : String(e)}`);
    return { registered, skipped };
  }

  for (const svc of services) {
    const deployed = deployedHealthcheck(nodeName, svc);
    const fromTemplate = await templateHealthcheck(svc.name);
    const config = deployed ?? fromTemplate;
    if (!config) { skipped.push(svc.name); continue; }

    // ADR 0012: never silent. A probe target that disagrees with the current
    // template is exactly the drift that made #2656 unfalsifiable — say it,
    // and say what closes it. No auto-reconcile happens here.
    if (deployed && fromTemplate && probeTarget(deployed) !== probeTarget(fromTemplate)) {
      logger.warn(
        'ServiceHealth',
        `bootstrap: ${svc.name} is DEPLOYED with health probe ${probeTarget(deployed)} but its current template resolves ${probeTarget(fromTemplate)}. ` +
        `Probing the deployed target (that is what is running); redeploy ${svc.name} to converge the manifest onto the template.`,
      );
    }

    poller.register({ nodeName, serviceName: svc.name, config });
    registered.push(svc.name);
  }

  if (registered.length > 0) {
    logger.info('ServiceHealth', `bootstrap: registered ${registered.length} service health check(s): ${registered.join(', ')}`);
  }
  poller.start();
  return { registered, skipped };
}
