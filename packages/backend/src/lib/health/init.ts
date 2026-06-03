import { HealthStore } from './store';
import { ServiceManager } from '../services/ServiceManager';
import { getConfig } from '../config';
import { listNodes } from '../nodes';
import crypto from 'crypto';
import { logger } from '@/lib/logger';

async function addGatewayCheck(config: Awaited<ReturnType<typeof getConfig>>, _exists: (type: string, target: string) => boolean) {
  if (config.gateway?.host && !_exists('ping', config.gateway.host)) {
    logger.info('Health', `Adding Configured Gateway check for ${config.gateway.host}`);
    HealthStore.saveCheck({
      id: crypto.randomUUID(),
      name: 'Internet Gateway',
      type: 'ping',
      target: config.gateway.host,
      interval: 60,
      enabled: true,
      created_at: new Date().toISOString()
    });
  }
}

/**
 * Per-service health checks are gated on actual deployment (#1506):
 * `listServices` reads the deployed Quadlet files off the digital twin, so
 * it is the authoritative set of installed stacks. We reconcile the on-disk
 * checks to that set — add a check for any deployed service that lacks one,
 * and prune any auto-created `Service:` check whose target is no longer
 * deployed (an uninstall the box missed, or a stale check from a prior
 * install). An un-installed service must show no check, never a red
 * "failing" one. `podman.socket` is a ServiceBay-internal singleton (added
 * separately) and is exempt from the prune.
 */
const SERVICE_CHECK_PRUNE_EXEMPT = new Set<string>(['podman.socket']);

/** A v4-style UUID, the id shape the UI's "add check" flow stamps
 *  (`crypto.randomUUID()`). Template/post-deploy-registered checks instead
 *  use a stable lowercase slug id (`home-assistant-api`, `ollama-api`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * Template-registered checks (#1551): a stack's post-deploy may register an
 * extra `http`/`tcp`/`script` probe against its own endpoint via
 * `POST /api/health/checks` (e.g. home-assistant's `home-assistant-api`,
 * oscar-ollama's `ollama-api`). These carry no `type:'service'` link, so the
 * service-row prune above misses them and they linger as `0ms` rows for an
 * un-installed (or never-installed-on-this-box) service.
 *
 * Bind such a check to a service by its **id slug**: a template check's id is
 * a stable lowercase slug whose leading segment is the owning service name
 * (`<service>` or `<service>-<suffix>`). A manually-added check carries a
 * `crypto.randomUUID()` id, so it never matches and is never pruned. Returns
 * true when the check is a template-registered probe whose owner is not in the
 * deployed set.
 */
function isOrphanTemplateCheck(c: { id: string; type: string }, deployed: Set<string>): boolean {
  if (c.type !== 'http' && c.type !== 'tcp' && c.type !== 'script') return false;
  if (UUID_RE.test(c.id) || !SLUG_ID_RE.test(c.id)) return false;
  // Owned by a deployed service? (id === <svc> or id starts with `<svc>-`)
  for (const svc of deployed) {
    if (c.id === svc || c.id.startsWith(`${svc}-`)) return false;
  }
  return true;
}

async function addServiceChecks(existingChecks: ReturnType<typeof HealthStore.getChecks>, _exists: (type: string, target: string) => boolean) {
  try {
    const services = await ServiceManager.listServices('Local');
    const deployed = new Set(services.map(s => s.name));

    // Prune auto-created per-service checks for services that are no longer
    // deployed. Only touches `type:'service'` rows the deploy/discovery path
    // creates — manual checks of other types are untouched.
    for (const c of existingChecks) {
      if (c.type !== 'service') continue;
      if (SERVICE_CHECK_PRUNE_EXEMPT.has(c.target)) continue;
      if (!deployed.has(c.target)) {
        logger.info('Health', `Pruning health check for un-installed service ${c.target}`);
        HealthStore.deleteServiceCheck(c.target);
      }
    }

    // Prune template-registered http/tcp/script probes whose owning stack is
    // not deployed (#1551) — these slip past the `type:'service'` prune above
    // and otherwise linger forever (e.g. a stale `ollama-api`/`home-assistant-api`
    // row carried over a wipe-configs reinstall, a restored config backup, or a
    // missed uninstall).
    for (const c of existingChecks) {
      if (isOrphanTemplateCheck(c, deployed)) {
        logger.info('Health', `Pruning template-registered check ${c.id} for un-installed service`);
        HealthStore.deleteCheck(c.id);
      }
    }

    for (const service of services) {
      const alreadyMonitored = existingChecks.some(c =>
        (c.type === 'service' && c.target === service.name) ||
        (c.name === `Service: ${service.name}`)
      );
      if (!alreadyMonitored) {
        logger.info('Health', `Adding Managed Service check for ${service.name}`);
        HealthStore.saveCheck({
          id: crypto.randomUUID(),
          name: `Service: ${service.name}`,
          type: 'service',
          target: service.name,
          interval: 60,
          enabled: true,
          created_at: new Date().toISOString()
        });
      }
    }
  } catch (e) {
    logger.error('init', 'Failed to list managed services for auto-discovery', e);
  }
}

async function addAgentChecks(exists: (type: string, target: string) => boolean) {
  try {
    const nodes = await listNodes();
    const nodeNames = new Set(nodes.map(n => n.Name));
    nodeNames.add('Local');
    for (const nodeName of nodeNames) {
      if (!exists('agent', nodeName)) {
        logger.info('Health', `Adding Agent Health check for ${nodeName}`);
        HealthStore.saveCheck({
          id: crypto.randomUUID(),
          name: `Agent: ${nodeName}`,
          type: 'agent',
          target: nodeName,
          interval: 30,
          enabled: true,
          created_at: new Date().toISOString(),
          nodeName: 'Local'
        });
      }
    }
  } catch (e) {
    logger.error('Health', 'Failed to add agent checks', e);
  }
}

function addDefaultPhase3bChecks(exists: (type: string, target: string) => boolean) {
  const phase3bChecks: Array<{ id: string; name: string; interval: number }> = [
    { id: 'lan_ip_drift', name: 'LAN IP drift', interval: 300 },
    { id: 'npm_auth', name: 'NPM admin auth', interval: 900 },
    { id: 'cert_expiry', name: 'TLS certificate expiry', interval: 3600 },
    { id: 'cert_request_failure', name: 'Let\'s Encrypt cert requests', interval: 600 },
  ];
  for (const cfg of phase3bChecks) {
    if (!exists(cfg.id, 'Local')) {
      logger.info('Health', `Adding ${cfg.id} singleton check`);
      HealthStore.saveCheck({
        id: cfg.id,
        name: cfg.name,
        type: cfg.id as 'lan_ip_drift' | 'npm_auth' | 'cert_expiry' | 'cert_request_failure',
        target: 'Local',
        interval: cfg.interval,
        enabled: true,
        created_at: new Date().toISOString(),
        nodeName: 'Local',
      });
    }
  }
}

export async function initializeDefaultChecks() {
  logger.info('Health', 'Initializing default checks...');
  const existingChecks = HealthStore.getChecks();

  const staleSystemdSocket = existingChecks.find(c => c.type === 'systemd' && c.target === 'podman.socket');
  if (staleSystemdSocket) {
    HealthStore.deleteCheck(staleSystemdSocket.id);
    logger.info('Health', 'Removed stale systemd check for podman.socket (migrating to service type)');
  }

  const checks = HealthStore.getChecks();
  const exists = (type: string, target: string) =>
    checks.some(c => c.type === type && c.target === target);

  try {
    const config = await getConfig();
    await addGatewayCheck(config, exists);
  } catch (e) {
    logger.error('Health', 'Failed to add configured gateway check', e);
  }

  if (!exists('service', 'podman.socket')) {
    logger.info('Health', 'Adding Podman Socket check');
    HealthStore.saveCheck({
      id: crypto.randomUUID(),
      name: 'Podman Socket',
      type: 'service',
      target: 'podman.socket',
      interval: 60,
      enabled: true,
      created_at: new Date().toISOString()
    });
  }

  await addServiceChecks(existingChecks, exists);
  addDefaultPhase3bChecks(exists);
  await addAgentChecks(exists);
}
