import { AgentHandler } from './handler';
import { EventEmitter } from 'events';

export class AgentManager extends EventEmitter {
  private static instance: AgentManager;
  private agents: Map<string, AgentHandler> = new Map();

  private constructor() {
    super(); 
  }

  public static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  public getAgent(nodeName: string): AgentHandler {
    if (!this.agents.has(nodeName)) {
      const agent = new AgentHandler(nodeName);
      agent.on('connected', () => this.emit('agent:connected', nodeName));
      agent.on('disconnected', () => this.emit('agent:disconnected', nodeName));
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
}

export const agentManager = AgentManager.getInstance();
