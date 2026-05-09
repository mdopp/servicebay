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
      agent.on('connected', () => {
        this.emit('agent:connected', nodeName);
        // Ensure podman.socket is enabled on every agent connect (idempotent)
        agent.sendCommand('exec', { command: 'systemctl --user enable --now podman.socket' })
          .then(res => {
            if (res.code === 0) logger.info('AgentManager', `podman.socket enabled on ${nodeName}`);
            else logger.warn('AgentManager', `podman.socket enable failed on ${nodeName}: ${res.stderr}`);
          })
          .catch(e => logger.warn('AgentManager', `podman.socket check error on ${nodeName}:`, e));
      });
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
  
  // Bring the agent up, waiting for it to reconnect if necessary. The
  // common reason a single start() call fails is that the SSH session
  // has briefly gone away — for instance, ServiceBay just autoupdated
  // and the new container is mid-boot, or the host rebooted itself.
  // Before this retry loop, an install kicked off in that ~10–30 s
  // window failed every service in the wizard with "Agent disconnected"
  // and abandoned a half-done install. We now poll start() with backoff
  // until the agent is reachable or `timeoutMs` elapses.
  public async ensureAgent(nodeName: string, timeoutMs: number = 30_000): Promise<AgentHandler> {
      const agent = this.getAgent(nodeName);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      let attempt = 0;
      let lastError: unknown = null;
      while (true) {
          try {
              await agent.start();
              return agent;
          } catch (e) {
              lastError = e;
              attempt += 1;
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              // Cap each backoff so we still get several attempts in 30 s.
              const wait = Math.min(2_000, Math.max(500, 250 * 2 ** attempt));
              logger.warn(
                  'AgentManager',
                  `ensureAgent(${nodeName}) attempt ${attempt} failed, retrying in ${wait}ms: ${e instanceof Error ? e.message : String(e)}`,
              );
              await new Promise(resolve => setTimeout(resolve, Math.min(wait, remaining)));
          }
      }
      throw lastError instanceof Error
          ? lastError
          : new Error(`Agent on "${nodeName}" did not become ready within ${timeoutMs}ms`);
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
