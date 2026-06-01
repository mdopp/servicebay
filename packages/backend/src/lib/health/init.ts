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

async function addServiceChecks(existingChecks: ReturnType<typeof HealthStore.getChecks>, exists: (type: string, target: string) => boolean) {
  try {
    const services = await ServiceManager.listServices('Local');
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
