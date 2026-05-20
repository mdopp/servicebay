import { HealthStore } from './store';
import { ServiceManager } from '../services/ServiceManager';
import { getConfig } from '../config';
import { listNodes } from '../nodes';
import crypto from 'crypto';
import { logger } from '@/lib/logger';

export async function initializeDefaultChecks() {
  logger.info('Health', 'Initializing default checks...');
  const existingChecks = HealthStore.getChecks();

  // Migrate: podman.socket was incorrectly registered as systemd (system-level),
  // but it's a user unit and should be type "service" (systemctl --user)
  const staleSystemdSocket = existingChecks.find(c => c.type === 'systemd' && c.target === 'podman.socket');
  if (staleSystemdSocket) {
    HealthStore.deleteCheck(staleSystemdSocket.id);
    logger.info('Health', 'Removed stale systemd check for podman.socket (migrating to service type)');
  }

  // Re-read after migration
  const checks = HealthStore.getChecks();

  // Helper to check if exists
  const exists = (type: string, target: string) =>
    checks.some(c => c.type === type && c.target === target);

  // 0. Configured Gateway Check
  try {
    const config = await getConfig();
    if (config.gateway?.host) {
        if (!exists('ping', config.gateway.host)) {
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
  } catch (e) {
    logger.error('Health', 'Failed to add configured gateway check', e);
  }

  // 1. Auto-detected Gateway Check - REMOVED (Redundant with Configured Gateway & Agent Checks)

  // 2. Podman Socket (user-level unit, checked via systemctl --user)
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
    console.error('Failed to list managed services for auto-discovery', e);
  }

  // Phase 3b singleton checks (#484): four former diagnose probes
  // now run on the health-check scheduler. Each uses a deterministic
  // id so subsequent boots find them idempotently — the diagnose-side
  // readers look up the result by this exact id, so do NOT use
  // crypto.randomUUID here.
  //
  //   - lan_ip_drift           — 5 min;   compares config.reverseProxy.lanIp
  //                              to the live `ip route get` result.
  //   - npm_auth               — 15 min;  POST /api/tokens against NPM
  //                              with stored creds; 401 → stale.
  //   - cert_expiry            — 1 h;     lists letsencrypt certs and
  //                              flags ≤14d / expired ones.
  //   - cert_request_failure   — 10 min;  tails NPM letsencrypt.log
  //                              and surfaces recent ACME failures.
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

  // 4. Agent Health Checks
  try {
      const nodes = await listNodes();
      // Ensure specific Agent checks for all nodes + Local
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
                  interval: 30, // Frequent check for agent health
                  enabled: true,
                  created_at: new Date().toISOString(),
                  nodeName: 'Local' // The check runs locally (checking the manager state)
              });
          }
      }
  } catch (e) {
      logger.error('Health', 'Failed to add agent checks', e);
  }
}
