/**
 * Service-health bootstrap (#626 / Phase 3A).
 *
 * Discovers which deployed services ship a `servicebay.healthcheck`
 * annotation and registers each one with the `ServiceHealthPoller`.
 *
 * Sources the annotation from the bundled template (registry path) for
 * Phase 3A. That keeps the implementation simple at the cost of
 * skipping Mustache substitution — templates ship literal probe URLs
 * (e.g. `http://localhost:81/api`) until Phase 3B introduces resolution
 * from the deployed Quadlet YAML.
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
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { parseHealthcheckYaml } from './serviceHealthcheck';
import { getServiceHealthPoller } from './serviceHealth';

/**
 * Build the variable view used to render a healthcheck annotation.
 * Same precedence the wizard uses (operator overrides win over defaults),
 * minus the wizard-only fields (generated secrets, etc.) that have no
 * business in a probe URL. Phase 3B replaces this with the resolved
 * variable map from the deployed Quadlet YAML.
 */
async function buildVariableView(templateName: string): Promise<Record<string, string>> {
  const view: Record<string, string> = {};
  // 1. Template defaults
  try {
    const meta = await getTemplateVariables(templateName);
    if (meta) {
      for (const [name, def] of Object.entries(meta)) {
        if (def && typeof def === 'object' && 'default' in def && typeof def.default === 'string') {
          view[name] = def.default;
        }
      }
    }
  } catch { /* template lacks variables.json — fine */ }
  // 2. Operator-set globals (Settings → Template Settings)
  try {
    const cfg = await getConfig();
    Object.assign(view, cfg.templateSettings ?? {});
  } catch { /* config missing — fall through with defaults */ }
  return view;
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
    // The service `name` matches the template directory name for stack
    // services. Non-stack services (raw Quadlet drops) won't resolve and
    // are quietly skipped.
    const yaml = await getTemplateYaml(svc.name).catch(() => null);
    if (!yaml) { skipped.push(svc.name); continue; }
    const ann = readManifestAnnotations(yaml);
    if (!ann.healthcheckRaw) { skipped.push(svc.name); continue; }

    // Render `{{VAR}}` placeholders against template defaults + operator
    // overrides. Goes through the canonical renderer (#599) so HTML
    // escaping is uniformly disabled — annotations are YAML.
    const view = await buildVariableView(svc.name);
    const resolved = renderTemplate(ann.healthcheckRaw, view);

    // Strict re-parse: runtime needs concrete values, no placeholders.
    const parsed = parseHealthcheckYaml(resolved, { permissive: false });
    if (!parsed.ok) {
      logger.warn('ServiceHealth', `bootstrap: skipping ${svc.name} — invalid healthcheck annotation: ${parsed.errors.join('; ')}`);
      skipped.push(svc.name);
      continue;
    }

    poller.register({ nodeName, serviceName: svc.name, config: parsed.config });
    registered.push(svc.name);
  }

  if (registered.length > 0) {
    logger.info('ServiceHealth', `bootstrap: registered ${registered.length} service health check(s): ${registered.join(', ')}`);
  }
  poller.start();
  return { registered, skipped };
}
