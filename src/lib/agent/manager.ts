import { AgentHandler } from './handler';
import { EventEmitter } from 'events';
import { logger } from '@/lib/logger';

export class AgentManager extends EventEmitter {
  private static instance: AgentManager;
  private agents: Map<string, AgentHandler> = new Map();

  private constructor() {
    super(); 
  }

  public static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      const globalHelper = globalThis as unknown as { __agentManager?: AgentManager };
      if (!globalHelper.__agentManager) {
        globalHelper.__agentManager = new AgentManager();
      }
      AgentManager.instance = globalHelper.__agentManager;
    }
    return AgentManager.instance;
  }

  public getAgent(nodeName: string): AgentHandler {
    if (!this.agents.has(nodeName)) {
      const agent = new AgentHandler(nodeName);
      agent.on('connected', () => this.emit('agent:connected', nodeName));
      agent.on('disconnected', () => this.emit('agent:disconnected', nodeName));
      // Forward all agent events to the manager as 'agent:message'
      agent.on('event', (msg) => this.emit('agent:message', nodeName, msg));
      
      // Auto-start or lazy start? 
      // Lazy start is better (async). But AgentHandler.start() is async.
      // We return the handler processing instance. The caller must ensure connected or start() it.
      // Or we make getAgent async.
      // Let's keep it sync retrieval, caller awaits start().
      this.agents.set(nodeName, agent);
    }
    return this.agents.get(nodeName)!;
  }
  
  public async ensureAgent(nodeName: string): Promise<AgentHandler> {
      const agent = this.getAgent(nodeName);
      await agent.start();
      return agent;
  }
  
  public async setMonitoringAll(enabled: boolean): Promise<void> {
      logger.info('AgentManager', `Setting monitoring to ${enabled} for all agents`);
      const updates = Array.from(this.agents.values()).map(agent => agent.setMonitoring(enabled));
      await Promise.allSettled(updates);
  }

    public async restartAgent(nodeName: string, reason: string = 'manual', timeoutMs: number = 30000): Promise<void> {
      const agent = this.getAgent(nodeName);
      await agent.restart(reason, timeoutMs);
    }

    public async restartAll(reason: string = 'manual', timeoutMs: number = 30000): Promise<void> {
      const agents = Array.from(this.agents.values());
      logger.info('AgentManager', `Restarting ${agents.length} agents (${reason})`);
      await Promise.allSettled(agents.map(agent => agent.restart(reason, timeoutMs)));
    }
}

export const agentManager = AgentManager.getInstance();
