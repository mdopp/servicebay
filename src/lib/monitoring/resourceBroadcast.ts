import type { Server, Socket } from 'socket.io';
import { agentManager } from '../agent/manager';
import type { AgentHandler } from '../agent/handler';
import { logger } from '../logger';

const formatAgentIdSuffix = (agent?: AgentHandler) => {
  if (!agent) return '';
  const id = agent.getCurrentRunId?.();
  return id ? ` [id=${id}]` : '';
};

/**
 * Track which sockets are watching live resource metrics for a given node.
 * When the watcher count crosses zero, we toggle the agent's resource-mode
 * accordingly so we don't pay for metrics nobody sees.
 */
export class ResourceBroadcast {
  private viewers = new Map<string, Set<string>>();

  attach(io: Server) {
    io.on('connection', socket => this.bind(socket));
  }

  private bind(socket: Socket) {
    socket.on('monitor:resources:start', ({ node }: { node: string }) => {
      if (!node) return;
      let set = this.viewers.get(node);
      if (!set) {
        set = new Set();
        this.viewers.set(node, set);
      }
      set.add(socket.id);
      this.update(node);
    });

    socket.on('monitor:resources:stop', ({ node }: { node: string }) => {
      if (!node) return;
      const set = this.viewers.get(node);
      if (!set) return;
      set.delete(socket.id);
      this.update(node);
    });

    socket.on('disconnect', () => {
      for (const [node, set] of this.viewers.entries()) {
        if (set.delete(socket.id)) this.update(node);
      }
    });
  }

  private update(nodeName: string) {
    const set = this.viewers.get(nodeName);
    const isActive = set ? set.size > 0 : false;
    try {
      const agent = agentManager.getAgent(nodeName);
      agent.setResourceMode(isActive);
      logger.info('Server', `Updated resource mode for ${nodeName}${formatAgentIdSuffix(agent)}: ${isActive} (${set?.size || 0} viewers)`);
    } catch {
      // Agent might not be connected.
    }
  }
}
