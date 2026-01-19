import './scripts/load-env';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
import * as pty from 'node-pty';
import os from 'os';
import fs from 'fs';
import { setUpdaterIO } from './src/lib/updater';
import crypto from 'crypto';
// Monitoring init moved to Agent logic in V4
import { MonitoringService } from './src/lib/monitoring/service';
import { agentManager } from './src/lib/agent/manager';
import { AgentHandler } from './src/lib/agent/handler';
import { listNodes } from './src/lib/nodes';
import { AgentEvent } from './src/lib/agent/handler';
import { DigitalTwinStore, NodeTwin } from './src/lib/store/twin';
import { AgentMessage } from './src/lib/agent/types';
import { GatewayPoller } from './src/lib/gateway/poller';
import { logger } from './src/lib/logger';
import { migrateConfig, getConfig, updateConfig } from './src/lib/config';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const formatAgentIdSuffix = (agent?: AgentHandler) => {
    if (!agent) return '';
    const id = agent.getCurrentRunId?.();
    return id ? ` [id=${id}]` : '';
};

const ensureSessionId = () => {
    const existing = process.env.SERVICEBAY_SESSION;
    if (existing) return existing;
    const date = new Date().toISOString().split('T')[0];
    const suffix = crypto.randomBytes(4).toString('hex');
    const sessionId = `servicebay-${date}-${suffix}`;
    process.env.SERVICEBAY_SESSION = sessionId;
    return sessionId;
};

const sessionId = ensureSessionId();
logger.info('Server', `Session ID: ${sessionId}`);


// Global PTY state
interface PtySession {
  process: pty.IPty;
  history: string;
  lastActive: number;
}

const sessions = new Map<string, PtySession>();
const resourceViewers = new Map<string, Set<string>>(); // nodeName -> Set<socketId>

// Ensure configuration is encrypted on startup (migration)
// and apply initial configuration
(async () => {
  try {
    await migrateConfig();
        const config = await getConfig();
        if (!config.agent?.sessionId || config.agent.sessionId !== sessionId) {
            await updateConfig({
                agent: {
                    ...config.agent,
                    sessionId
                }
            });
        }
    if (config.logLevel) {
      logger.setLogLevel(config.logLevel);
      logger.info('Server', `Log level set to ${config.logLevel}`);
    }
  } catch (e) {
    logger.error('Server', 'Config initialization failed', e);
  }
})();

const scheduleAgentRestart = async () => {
    try {
        const config = await getConfig();
        const schedule = config.agent?.restartSchedule;
        if (!schedule?.enabled) return;

        const time = schedule.time || '03:00';
        const [hourStr, minuteStr] = time.split(':');
        const hour = Number(hourStr);
        const minute = Number(minuteStr);
        if (Number.isNaN(hour) || Number.isNaN(minute)) {
            logger.warn('Server', `Invalid agent restartSchedule time: ${time}`);
            return;
        }

        const now = new Date();
        const next = new Date(now);
        next.setUTCHours(hour, minute, 0, 0);
        if (next <= now) {
            next.setUTCDate(next.getUTCDate() + 1);
        }

        const delayMs = next.getTime() - now.getTime();
        logger.info('Server', `Scheduled agent restart at ${next.toISOString()} (${Math.round(delayMs / 1000)}s)`);

        setTimeout(async () => {
            try {
                const timeoutSeconds = config.agent?.gracefulShutdownTimeout ?? 30;
                await agentManager.restartAll('scheduled', timeoutSeconds * 1000);
                logger.info('Server', 'Scheduled agent restart completed.');
            } catch (err) {
                logger.error('Server', 'Scheduled agent restart failed', err);
            } finally {
                scheduleAgentRestart();
            }
        }, delayMs);
    } catch (err) {
        logger.error('Server', 'Failed to schedule agent restart', err);
    }
};

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error('Server', `Error occurred handling ${req.url}`, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new Server(server);
  const twinStore = DigitalTwinStore.getInstance();

  // Logging: Broadcast new logs to 'logs:live' room
  logger.onLog((entry) => {
      io.to('logs:live').emit('log:entry', entry);
  });

  const updateResourceMonitoring = (nodeName: string) => {
      const viewers = resourceViewers.get(nodeName);
      const isActive = viewers ? viewers.size > 0 : false;
      try {
          const agent = agentManager.getAgent(nodeName);
          agent.setResourceMode(isActive);
          logger.info('Server', `Updated resource mode for ${nodeName}${formatAgentIdSuffix(agent)}: ${isActive} (${viewers?.size || 0} viewers)`);
      } catch {
          // Agent might not be connected
      }
  };

  // Track active clients for monitoring optimization
  const updateMonitoringState = () => {
      // Small delay to allow io.engine.clientsCount to update after disconnect
      setTimeout(() => {
          const clientCount = io.engine.clientsCount;
          const shouldMonitor = clientCount > 0;
          logger.info('Server', `Active Clients: ${clientCount}. Monitoring Enabled: ${shouldMonitor}`);
          agentManager.setMonitoringAll(shouldMonitor);
      }, 100);
  };

  // Broadcast Twin Updates to UI
  twinStore.subscribe(() => {
      io.emit('twin:state', twinStore.getSnapshot());
  });
  
  // --- V4 Agent Event Bus Integration ---
  agentManager.on('agent:connected', (nodeName: string) => {
      const agent = agentManager.getAgent(nodeName);
      logger.info('Server', `Agent connected: ${nodeName}${formatAgentIdSuffix(agent)}`);
      twinStore.setNodeConnection(nodeName, true);
      io.emit('node:status', { node: nodeName, status: 'connected' });
      
      // If we have clients, enable monitoring on this new agent
      if (io.engine.clientsCount > 0) {
          agentManager.getAgent(nodeName).setMonitoring(true);
      }
  });
  agentManager.on('agent:disconnected', (nodeName: string) => {
      const agent = agentManager.getAgent(nodeName);
      logger.info('Server', `Agent disconnected: ${nodeName}${formatAgentIdSuffix(agent)}`);
      twinStore.setNodeConnection(nodeName, false);
      io.emit('node:status', { node: nodeName, status: 'disconnected' });
  });

  // Handle incoming V4.1 Agent Messages
  agentManager.on('agent:message', (nodeName: string, message: AgentMessage) => {
      if (message.type === 'SYNC_PARTIAL') {
          // Robust Partial Update: payload can be { containers: [] } or { initialSyncComplete: true }
          const keys = Object.keys(message.payload || {});
          let logMsg = `SYNC_PARTIAL from ${nodeName} | Keys: ${keys.join(', ')}`;
          
          if (message.payload && 'services' in message.payload && Array.isArray(message.payload.services)) {
              const serviceNames = message.payload.services.map(s => s.name).join(', ');
              logMsg += ` | Services: ${serviceNames}`;
          }

          const agent = agentManager.getAgent(nodeName);
          logger.info('Server', `${logMsg}${formatAgentIdSuffix(agent)}`);
          
          // Add health snapshot from agent
          const health = agent.getHealth();
          
          // TS "as any" is simplistic but TwinStore handles Partial<NodeTwin> safely.
          const update: Partial<NodeTwin> = { ...message.payload as unknown as Partial<NodeTwin>, health };
          twinStore.updateNode(nodeName, update);
        } else if (message.type === 'SYNC_DIFF') {
            const agent = agentManager.getAgent(nodeName);
            logger.info('Server', `SYNC_DIFF from ${nodeName}${formatAgentIdSuffix(agent)}`);
         
         // Add health snapshot from agent
         const health = agent.getHealth();
         
         // TODO: Implement diff patching
         const update: Partial<NodeTwin> = { ...message.payload as unknown as Partial<NodeTwin>, health };
         twinStore.updateNode(nodeName, update);
      }
  });
  
  // Subscribe to specific agent events and broadcast
  const broadcastAgentEvent = (nodeName: string, event: AgentEvent) => {
       io.emit('agent:event', { node: nodeName, ...event });
       
       // Helper for specific UI updates
       if (event.type === 'file:change') {
           io.emit('service:list-stale', { node: nodeName }); 
       }
  };
  
  // Auto-connect agents for known nodes
  listNodes().then(nodes => {
      // Ensure Local Agent is initialized and hooked up to the Event Bus
      const targets = [...nodes];
      if (!targets.find(n => n.Name === 'Local')) {
          targets.push({ Name: 'Local', URI: 'local', Identity: '', Default: false });
      }

      targets.forEach(node => {
         const agent = agentManager.getAgent(node.Name);
         // Forward events
         agent.on('event', (e: AgentEvent) => broadcastAgentEvent(node.Name, e));
         
         // Start connection in background
         agent.start().catch(err => {
             logger.error(node.Name, 'Failed to auto-connect:', err.message);
         });
      });
  });

  // Pass IO to updater
  setUpdaterIO(io);

  // Initialize Monitoring Service (V4 Legacy Bridge)
  MonitoringService.init(io).catch(err => {
      logger.error('Server', 'Failed to start monitoring service:', err);
  });
  
  // Start V4.1 Gateway Poller
  GatewayPoller.getInstance().start().catch(err => {
      logger.error('Server', 'Failed to start Gateway Poller:', err);
  });

    // Schedule agent restarts based on config
    scheduleAgentRestart();

  // Periodic Agent Health Sync (every 30 seconds)
  setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agents = (agentManager as any).agents as Map<string, { getHealth: () => any }>;
      agents.forEach((agent, nodeName) => {
          const health = agent.getHealth();
          twinStore.updateNode(nodeName, { health });
      });
  }, 30000);



  // Function to spawn a PTY
  const ensurePty = async (id: string, cols: number = 80, rows: number = 30) => {
    if (sessions.has(id)) {
        const session = sessions.get(id)!;
        // Resize existing session if dimensions differ and are valid
        if (cols > 0 && rows > 0) {
            try {
                session.process.resize(cols, rows);
            } catch (e) {
                logger.error('Server', `Error resizing existing session ${id}:`, e);
            }
        }
        return session;
    }

    let shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
    let args: string[] = [];

    if (id.startsWith('container:')) {
        const parts = id.split(':');
        // Format: container:NODE:ID or container:ID (legacy/local)
        let nodeName = 'local';
        let containerId = '';

        if (parts.length === 3) {
            nodeName = parts[1];
            containerId = parts[2];
        } else {
            containerId = parts[1];
        }

        if (!containerId) {
            logger.error('Server', 'Invalid container ID');
            if (sessions.has('host')) return sessions.get('host')!;
            throw new Error('Invalid container ID');
        }

        if (nodeName && nodeName !== 'local') {
            try {
                const nodes = await listNodes();
                const node = nodes.find(n => n.Name === nodeName);
                if (node) {
                    const uri = new URL(node.URI);
                    if (uri.protocol === 'ssh:') {
                        shell = 'ssh';
                        args = [];
                        
                        if (node.Identity) args.push('-i', node.Identity);
                        if (uri.port) args.push('-p', uri.port);
                        
                        args.push('-o', 'StrictHostKeyChecking=no');
                        args.push('-o', 'UserKnownHostsFile=/dev/null');
                        args.push('-t'); // Force PTY allocation
                        
                        args.push(`${uri.username}@${uri.hostname}`);
                        
                        // Command to run on remote
                        args.push(`podman exec -it -e TERM=xterm-256color ${containerId} sh -c 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi'`);
                    }
                }
            } catch (e) {
                logger.error('Server', `Failed to setup remote container terminal for ${nodeName}:`, e);
            }
        } else {
            shell = 'podman';
            // Try to use bash if available, otherwise sh. Pass TERM env var.
            args = ['exec', '-it', '-e', 'TERM=xterm-256color', containerId, 'sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi'];
        }
    } else if (id.startsWith('node:')) {
        const nodeName = id.split(':')[1];
        try {
            const nodes = await listNodes();
            const node = nodes.find(n => n.Name === nodeName);
            if (node) {
                // Parse URI: ssh://user@host:port/path
                const uri = new URL(node.URI);
                if (uri.protocol === 'ssh:') {
                    shell = 'ssh';
                    args = [];
                    
                    // Identity file
                    if (node.Identity) {
                        args.push('-i', node.Identity);
                    }
                    
                    // Port
                    if (uri.port) {
                        args.push('-p', uri.port);
                    }
                    
                    // StrictHostKeyChecking=no to avoid interactive prompts on first connect
                    args.push('-o', 'StrictHostKeyChecking=no');
                    args.push('-o', 'UserKnownHostsFile=/dev/null');
                    
                    // User and Host
                    args.push(`${uri.username}@${uri.hostname}`);
                }
            }
        } catch (e) {
            logger.error('Server', 'Failed to resolve node connection', e);
        }
    }
    
    logger.info('Server', `Spawning PTY: ${shell} ${args.join(' ')}`);

    let cwd = process.env.HOME;
    try {
        if (!cwd || !fs.existsSync(cwd)) {
            logger.warn('Server', `Home directory ${cwd} invalid or missing. Defaulting terminal CWD to /`);
            cwd = '/';
        }
    } catch {
        // Fallback for strict permissions
        cwd = '/';
    }

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 30,
      cwd: cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: { ...process.env, TERM: 'xterm-256color' } as any
    });

    logger.info('Server', `Spawned new PTY process for ${id} (PID: ${ptyProcess.pid})`);

    const session: PtySession = {
        process: ptyProcess,
        history: `\r\n\x1b[32m>>> Connected to terminal session: ${id}\x1b[0m\r\n`,
        lastActive: Date.now()
    };

    sessions.set(id, session);

    ptyProcess.onData((data) => {
      session.history += data;
      session.lastActive = Date.now();
      // Keep buffer size reasonable (e.g., 100KB)
      if (session.history.length > 100000) {
        session.history = session.history.substring(session.history.length - 100000);
      }
      // Broadcast to room
      io.to(id).emit('output', data);
    });

    ptyProcess.onExit((e) => {
      const code = e.exitCode;
      logger.info('Server', `PTY process ${id} exited with code ${code}`);
      io.to(id).emit('output', `\r\n\x1b[31m>>> Session exited with code ${code}\x1b[0m\r\n`);
      sessions.delete(id);
    });

    return session;
  };

  // Initialize host PTY immediately
  ensurePty('host').catch(err => logger.error('Server', 'ensurePty(host) failed', err));

  io.on('connection', (socket) => {
    logger.info('Server', 'Client connected');
    updateMonitoringState();
    
    // Send immediate initial state to new client
    socket.emit('twin:state', twinStore.getSnapshot());
    
    socket.on('join', async (payload: string | { id: string, cols?: number, rows?: number }) => {
        let id: string;
        let cols = 80;
        let rows = 30;

        if (typeof payload === 'string') {
            id = payload;
        } else {
            id = payload.id;
            cols = payload.cols || 80;
            rows = payload.rows || 30;
        }
        
        logger.info('Server', `Client joining terminal ${id} with dims ${cols}x${rows}`);
        socket.join(id);
        try {
            const session = await ensurePty(id, cols, rows);
            socket.emit('history', session.history);
        } catch (e) {
            logger.error('Server', 'Failed to join terminal:', e);
            socket.emit('output', '\r\n\x1b[31m>>> Failed to join terminal session.\x1b[0m\r\n');
        }
    });

    // Logging Subscription
    socket.on('logs:subscribe', () => {
        socket.join('logs:live');
    });

    socket.on('logs:unsubscribe', () => {
        socket.leave('logs:live');
    });

    socket.on('input', ({ id, data }: { id: string, data: string }) => {
      const session = sessions.get(id);
      if (session) {
        session.process.write(data);
        session.lastActive = Date.now();
      }
    });

    socket.on('resize', ({ id, cols, rows }: { id: string, cols: number, rows: number }) => {
      const session = sessions.get(id);
      if (session) {
        session.process.resize(cols, rows);
      }
    });

    // Resource Monitoring Protocol
    socket.on('monitor:resources:start', ({ node }: { node: string }) => {
        if (!node) return;
        if (!resourceViewers.has(node)) resourceViewers.set(node, new Set());
        resourceViewers.get(node)!.add(socket.id);
        updateResourceMonitoring(node);
    });

    socket.on('monitor:resources:stop', ({ node }: { node: string }) => {
        if (!node || !resourceViewers.has(node)) return;
        resourceViewers.get(node)!.delete(socket.id);
        updateResourceMonitoring(node);
    });

    socket.on('disconnect', () => {
      logger.info('Server', 'Client disconnected');
      
      // Remove from all resource viewing groups
      for (const [node, viewers] of resourceViewers.entries()) {
          if (viewers.delete(socket.id)) {
              updateResourceMonitoring(node);
          }
      }

      updateMonitoringState();
    });
  });

  // Cleanup inactive container sessions
  setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions.entries()) {
          if (id !== 'host' && now - session.lastActive > 1000 * 60 * 5) { // 5 mins inactivity
              logger.info('Server', `Killing inactive session ${id}`);
              session.process.kill();
              sessions.delete(id);
          }
      }
  }, 60000);

  server.listen(port, async () => {
    logger.info('Server', `> Ready on http://${hostname}:${port}`);

    // Auto-update logic to be migrated to Executor Task
  });
});
