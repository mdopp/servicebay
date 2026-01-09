import { DigitalTwinStore } from '../store/twin';
import { GatewayProvider } from './types';
import { FritzBoxProvider } from './fritzbox';
import { getConfig } from '../config';
import { logger } from '@/lib/logger';

export class GatewayPoller {
  private static instance: GatewayPoller;
  private provider: GatewayProvider | null = null;
  private interval: NodeJS.Timeout | null = null;
  private store: DigitalTwinStore;

  private constructor() {
    this.store = DigitalTwinStore.getInstance();
  }

  public static getInstance(): GatewayPoller {
    if (!GatewayPoller.instance) {
      GatewayPoller.instance = new GatewayPoller();
    }
    return GatewayPoller.instance;
  }

  public async start() {
    if (this.interval) return;

    const config = await getConfig();

    // Detect provider based on config
    if (config.gateway?.type === 'fritzbox') {
        this.provider = new FritzBoxProvider(config.gateway);
    } else {
        // Fallback or Mock
        logger.warn('GatewayPoller', 'No gateway configured. Using Mock Gateway.');
        this.provider = {
            name: 'Mock',
            init: async () => {},
            poll: async () => ({
                provider: 'mock',
                publicIp: '127.0.0.1',
                internalIp: '192.168.178.1', 
                upstreamStatus: 'up',
                dnsServers: ['8.8.8.8', '1.1.1.1'],
                uptime: 12345,
                lastUpdated: Date.now()
            })
        };
    }

    logger.info('GatewayPoller', `Starting with provider: ${this.provider.name}`);
    await this.provider.init();

    // Initial poll
    await this.poll();

    // Loop
    this.interval = setInterval(() => this.poll(), 60000); // 1 minute
  }
  
  public stop() {
      if (this.interval) clearInterval(this.interval);
      this.interval = null;
  }

  private async poll() {
    if (!this.provider) return;
    try {
        const update = await this.provider.poll();
        this.store.updateGateway(update);
    } catch (e) {
        logger.error('GatewayPoller', 'Error:', e);
    }
  }
}
