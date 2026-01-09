import { FritzBoxClient } from '../fritzbox/client';
import { GatewayProvider, GatewayState } from './types';
import { GatewayConfig } from '../config';
import { logger } from '@/lib/logger';

export class FritzBoxProvider implements GatewayProvider {
  public name = 'FritzBox';
  private client: FritzBoxClient;

  constructor(config?: GatewayConfig) {
    this.client = new FritzBoxClient({
      username: config?.username,
      password: config?.password,
      host: config?.host
    });
  }

  async init(): Promise<void> {
    // Client auto-initializes on first call usually
  }

  async poll(): Promise<Partial<GatewayState>> {
    try {
      const status = await this.client.getStatus();
      
      return {
        provider: 'fritzbox',
        publicIp: status.externalIP || '0.0.0.0',
        internalIp: status.internalIP || undefined, 
        upstreamStatus: status.connected ? 'up' : 'down',
        dnsServers: status.dnsServers,
        uptime: status.uptime,
        lastUpdated: Date.now()
      };
    } catch (e) {
      logger.error('FritzGateway', 'Poll failed', e);
      return {
        upstreamStatus: 'down',
        lastUpdated: Date.now()
      };
    }
  }
}
