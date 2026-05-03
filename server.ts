import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
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
import { syncRegistries } from './src/lib/registry';
import { createMcpServer } from './src/lib/mcp/server';
import { scheduleBackup } from './src/lib/backup/service';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TerminalSessionManager } from './src/lib/terminal/sessionManager';
import { ResourceBroadcast } from './src/lib/monitoring/resourceBroadcast';
import { CharRingBuffer } from './src/lib/util/ringBuffer';
import { SSHConnectionPool } from './src/lib/ssh/pool';
import { assertAuthSecret, getSessionFromCookieHeader, type SessionPayload } from './src/lib/auth/session';

// Fail-fast at startup so misconfigured deploys don't appear to work.
assertAuthSecret();

// Helper: collect request body as parsed JSON
function collectBody(req: import('http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
// when using a Next.js proxy (formerly middleware), `hostname` and `port` must be provided below
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


// Terminal sessions and resource broadcast moved into dedicated modules
// (src/lib/terminal/sessionManager.ts, src/lib/monitoring/resourceBroadcast.ts).
// CharRingBuffer is wired in below via TerminalSessionManager's createHistory
// option to keep PR 3's bounded scrollback behavior.

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

      // MCP endpoint — intercept before Next.js handler
      if (parsedUrl.pathname === '/mcp') {
        // Only POST is supported in stateless mode
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null,
          }));
          return;
        }

        // Auth: MCP lives outside /api/* so the Next proxy gate doesn't see it.
        const session = await getSessionFromCookieHeader(req.headers.cookie);
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null,
          }));
          return;
        }

        // Stateless: create a fresh server + transport per request
        const mcpServer = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcpServer.connect(transport);
        const body = await collectBody(req);
        await transport.handleRequest(req, res, body);
        res.on('close', () => {
          transport.close();
          mcpServer.close();
        });
        return;
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error('Server', `Error occurred handling ${req.url}`, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new Server(server);

  // Socket.IO auth: every connection must carry a valid session cookie.
  io.use(async (socket, next) => {
    const session = await getSessionFromCookieHeader(socket.handshake.headers.cookie);
    if (!session) {
      logger.warn('Server', `Rejected unauthenticated socket from ${socket.handshake.address}`);
      return next(new Error('unauthorized'));
    }
    (socket.data as { user?: SessionPayload }).user = session;
    next();
  });

  const twinStore = DigitalTwinStore.getInstance();

  // Load serverName from config into twin store
  getConfig().then(config => {
    if (config.serverName) {
      twinStore.setServerName(config.serverName);
    }
  }).catch(() => { /* ignore */ });

  // Logging: Broadcast new logs to 'logs:live' room
  logger.onLog((entry) => {
      io.to('logs:live').emit('log:entry', entry);
  });

  // Resource-mode broadcasting (moved into ResourceBroadcast).
  const resourceBroadcast = new ResourceBroadcast();
  resourceBroadcast.attach(io);

  // Terminal session manager (moved into TerminalSessionManager). Plug in the
  // bounded CharRingBuffer from PR 3 — caps each PTY's scrollback at 50KB
  // with newline-aligned truncation, replacing the substring-shift fallback.
  const terminalManager = new TerminalSessionManager({
    io,
    historyBytes: 50_000,
    createHistory: (bytes) => new CharRingBuffer(bytes),
  });
  terminalManager.start();

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

    // Schedule backup sync based on config
    scheduleBackup();

  // Periodic Agent Health Sync (every 30 seconds)
  setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agents = (agentManager as any).agents as Map<string, { getHealth: () => any }>;
      agents.forEach((agent, nodeName) => {
          const health = agent.getHealth();
          twinStore.updateNode(nodeName, { health });
      });
  }, 30000);



  // Server-owned socket lifecycle: just the bits that aren't the terminal or
  // resource broadcast (those are owned by their dedicated managers).
  io.on('connection', (socket) => {
    logger.info('Server', 'Client connected');
    updateMonitoringState();
    socket.emit('twin:state', twinStore.getSnapshot());

    socket.on('logs:subscribe', () => { socket.join('logs:live'); });
    socket.on('logs:unsubscribe', () => { socket.leave('logs:live'); });
    socket.on('disconnect', () => {
      logger.info('Server', 'Client disconnected');
      updateMonitoringState();
    });
  });

  // ─── Graceful shutdown ─────────────────────────────────────────────
  // PTY sweep + session cleanup live inside TerminalSessionManager; we just
  // ask the manager to stop, then drain everything else.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Server', `Received ${signal}, starting graceful shutdown`);

      const finish = setTimeout(() => {
          logger.error('Server', 'Graceful shutdown timeout, forcing exit');
          process.exit(1);
      }, 10_000);
      finish.unref();

      try {
          terminalManager.stop();
          io.close();
          await SSHConnectionPool.getInstance().shutdown(2000);
          await new Promise<void>(resolve => server.close(() => resolve()));
          logger.info('Server', 'Shutdown complete');
          process.exit(0);
      } catch (e) {
          logger.error('Server', 'Error during shutdown', e);
          process.exit(1);
      }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('uncaughtException', (err) => {
      logger.error('Server', 'uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
      logger.error('Server', 'unhandledRejection', reason);
  });


  server.listen(port, async () => {
    logger.info('Server', `> Ready on http://${hostname}:${port}`);

    // Sync template registries in background (non-blocking)
    syncRegistries().catch(err => logger.warn('Server', `Registry sync failed: ${err}`));

    // Auto-update logic to be migrated to Executor Task
  });
});
