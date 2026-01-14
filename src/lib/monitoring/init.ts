import { MonitoringStore } from './store';
import { ServiceManager } from '../services/ServiceManager';
import { getConfig } from '../config';
import { listNodes } from '../nodes';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { logger } from '@/lib/logger';

const execAsync = promisify(exec);

export async function initializeDefaultChecks() {
  logger.info('Monitoring', 'Initializing default checks...');
  const existingChecks = MonitoringStore.getChecks();

  // Helper to check if exists
  const exists = (type: string, target: string) => 
    existingChecks.some(c => c.type === type && c.target === target);

  // 0. Configured Gateway Check
  try {
    const config = await getConfig();
    if (config.gateway?.host) {
        if (!exists('ping', config.gateway.host)) {
            logger.info('Monitoring', `Adding Configured Gateway check for ${config.gateway.host}`);
            MonitoringStore.saveCheck({
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
  } catch (e) {
    logger.error('Monitoring', 'Failed to add configured gateway check', e);
  }

  // 1. Auto-detected Gateway Check
  try {
    // ip route show default usually outputs: "default via 192.168.1.1 dev eth0 ..."
    const { stdout } = await execAsync("ip route show default");
    const match = stdout.match(/via\s+([0-9.]+)/);
    if (match && match[1]) {
      const gateway = match[1];
      if (!exists('ping', gateway)) {
          logger.info('Monitoring', `Adding Gateway check for ${gateway}`);
          MonitoringStore.saveCheck({
              id: crypto.randomUUID(),
              name: 'Gateway',
              type: 'ping',
              target: gateway,
              interval: 60,
              enabled: true,
              created_at: new Date().toISOString()
          });
      }
    }
  } catch (e) {
    logger.error('Monitoring', 'Failed to detect gateway', e);
  }

  // 2. Podman Socket (more reliable than service for API availability)
  if (!exists('systemd', 'podman.socket')) {
    logger.info('Monitoring', 'Adding Podman Socket check');
    MonitoringStore.saveCheck({
        id: crypto.randomUUID(),
        name: 'Podman Socket',
        type: 'systemd',
        target: 'podman.socket',
        interval: 60,
        enabled: true,
        created_at: new Date().toISOString()
    });
  }

  // 3. Managed Services
  try {
    const services = await ServiceManager.listServices('Local');
    for (const service of services) {
        // Check if we have a check for this service (either by name or target)
        const alreadyMonitored = existingChecks.some(c => 
            (c.type === 'service' && c.target === service.name) ||
            (c.name === `Service: ${service.name}`)
        );

        if (!alreadyMonitored) {
            logger.info('Monitoring', `Adding Managed Service check for ${service.name}`);
            MonitoringStore.saveCheck({
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
    console.error('Failed to list managed services for auto-discovery', e);
  }

  // 4. Agent Health Checks
  try {
      const nodes = await listNodes();
      // Ensure specific Agent checks for all nodes + Local
      const nodeNames = new Set(nodes.map(n => n.Name));
      nodeNames.add('Local');

      for (const nodeName of nodeNames) {
          if (!exists('agent', nodeName)) {
              logger.info('Monitoring', `Adding Agent Health check for ${nodeName}`);
              MonitoringStore.saveCheck({
                  id: crypto.randomUUID(),
                  name: `Agent: ${nodeName}`,
                  type: 'agent',
                  target: nodeName,
                  interval: 30, // Frequent check for agent health
                  enabled: true,
                  created_at: new Date().toISOString(),
                  nodeName: 'Local' // The check runs locally (checking the manager state)
              });
          }
      }
  } catch (e) {
      logger.error('Monitoring', 'Failed to add agent checks', e);
  }
}
