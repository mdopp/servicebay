import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

// Catch rejections that happen during early bootstrap (before app.prepare().then
// installs the proper handler). Without this, Next 16's source-map ignore-list
// hides the real stack and we only see "at ignore-listed frames".
process.on('unhandledRejection', (reason) => {
   
  console.error('[BOOT] unhandledRejection:', reason);
  if (reason instanceof Error && reason.stack) {
     
    console.error('[BOOT] stack:', reason.stack);
  }
});

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
import { setUpdaterIO, scheduleUpdateNotifier } from './packages/backend/src/lib/updater';
import { runWithTrace, newTraceId, currentTraceId } from './packages/backend/src/lib/util/traceContext';
import { setTraceProvider } from './packages/backend/src/lib/logger';
import crypto from 'crypto';
// Monitoring init moved to Agent logic in V4
import { HealthService } from './packages/backend/src/lib/health/service';
import { initCapabilities } from './packages/backend/src/lib/capabilities/init';
import { agentManager } from './packages/backend/src/lib/agent/manager';
import { AgentHandler } from './packages/backend/src/lib/agent/handler';
import { listNodes } from './packages/backend/src/lib/nodes';
import { AgentEvent } from './packages/backend/src/lib/agent/handler';
import { DigitalTwinStore, NodeTwin } from './packages/backend/src/lib/store/twin';
import { AgentMessage } from './packages/backend/src/lib/agent/types';
import { GatewayPoller } from './packages/backend/src/lib/gateway/poller';
import { startFlowSampler } from './packages/backend/src/lib/network/flowSampler';
import { logger } from './packages/backend/src/lib/logger';
import { migrateConfig, getConfig, updateConfig } from './packages/backend/src/lib/config';
import { syncRegistries } from './packages/backend/src/lib/registry';
import { reconcileLanIp } from './packages/backend/src/lib/lanIp';
import { lazyInitializeExpiry as initBootstrapTokenExpiry } from './packages/backend/src/lib/mcp/bootstrapToken';
import { createMcpServer } from './packages/backend/src/lib/mcp/server';
import { scheduleBackup } from './packages/backend/src/lib/backup/service';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TerminalSessionManager } from './packages/backend/src/lib/terminal/sessionManager';
import { ResourceBroadcast } from './packages/backend/src/lib/health/resourceBroadcast';
import { CharRingBuffer } from './packages/backend/src/lib/util/ringBuffer';
import { SSHConnectionPool } from './packages/backend/src/lib/ssh/pool';
import { assertAuthSecret, getSessionFromCookieHeader, type SessionPayload } from './packages/backend/src/lib/auth/session';
import { setIo as setInstallSocketIo } from './packages/backend/src/lib/install/socketBridge';
import { markCrashedOnStartup as markCrashedInstallsOnStartup } from './packages/backend/src/lib/install/jobStore';

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

// Wire the trace-ID provider so logger.* calls inside a request frame
// persist the trace_id column (#597). Decoupled from logger.ts so that
// module doesn't transitively pull node:async_hooks into client bundles.
setTraceProvider(currentTraceId);


// Terminal sessions and resource broadcast moved into dedicated modules
// (src/lib/terminal/sessionManager.ts, src/lib/health/resourceBroadcast.ts).
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

// Portal apex/www auto-provisioner (#242 follow-up). Schedule with a
// 60s delay so cold-starting nginx + adguard have time to come up;
// the function is idempotent and only acts when both services are
// reachable. Logs failures and skips silently — next boot retries.
setTimeout(() => {
  void (async () => {
    try {
      const { provisionPortalRouting } = await import('./packages/backend/src/lib/portal/provisioner');
      await provisionPortalRouting();
    } catch (e) {
      logger.warn('Server', 'Portal routing provisioner failed:', e);
    }
  })();
}, 60_000).unref();

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
  const server = createServer((req, res) => runWithTrace(async () => {
    // Surface the trace ID to the client so error toasts can include it
    // (#594). Cheap: a single response header, set once per request.
    const traceId = currentTraceId();
    if (traceId && !res.headersSent) res.setHeader('X-Trace-Id', traceId);
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
        // Two paths supported:
        //   1. Authorization: Bearer sb_<id>_<secret>   — scoped API token
        //   2. Cookie: session=...                      — full-access (legacy)
        // Token path is preferred; cookie kept for back-compat with clients
        // that connected before tokens existed.
        const { verifyToken } = await import('./packages/backend/src/lib/mcp/tokens');
        const { verifyBootstrapToken } = await import('./packages/backend/src/lib/mcp/bootstrapToken');
        const authHeader = req.headers.authorization || '';
        const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
        let auth: { user: string; scopes: import('./packages/backend/src/lib/mcp/tokens').ApiScope[]; tokenId?: string } | null = null;
        let authError: string | null = null;
        try {
          if (bearerMatch) {
            const t = await verifyToken(bearerMatch[1]);
            if (t) auth = { user: `token:${t.name}`, scopes: t.scopes, tokenId: t.id };
            // Bootstrap token (#322): only valid bearer that doesn't
            // match the sb_<id>_<secret> shape. Always read-only, always
            // LAN-only, always TTL'd. The verifier handles all three
            // gates — server.ts just hands off remoteAddress.
            if (!auth) {
              const remoteIp = (req.socket?.remoteAddress) ?? undefined;
              const bt = await verifyBootstrapToken(bearerMatch[1], remoteIp);
              if (bt) auth = bt;
            }
          }
        } catch (err) {
          authError = err instanceof Error ? err.message : String(err);
        }
        if (!auth) {
          const session = await getSessionFromCookieHeader(req.headers.cookie);
          if (session) {
            // Cookie auth retains full scopes for back-compat. Fresh
            // installs that want stricter behaviour use named tokens.
            auth = { user: session.user, scopes: ['read', 'lifecycle', 'mutate', 'destroy'] };
          }
        }
        if (!auth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: authError || 'Unauthorized — provide Authorization: Bearer sb_… or a session cookie',
            },
            id: null,
          }));
          return;
        }

        // Stateless: create a fresh server + transport per request, with
        // the auth context closed over so each tool call can scope-check.
        const mcpServer = createMcpServer({ auth });
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
  }, newTraceId()));

  const io = new Server(server);

  // Wire the install runner's socket bridge so server-side install jobs
  // can broadcast progress to all connected clients via install:update /
  // install:log events. Pair with the markCrashedOnStartup call below.
  setInstallSocketIo(io);

  // Recover from a previous server crash: any install job left in an
  // active phase belonged to a process that died mid-deploy. Flip those
  // to 'crashed' so the wizard surfaces a Start-over button instead of
  // polling for an update that will never arrive.
  markCrashedInstallsOnStartup()
    .then((n) => {
      if (n > 0) logger.info('Server', `Marked ${n} crashed install job(s) on startup.`);
    })
    .catch(() => { /* best-effort */ });

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

  // Capability bus (#629 / Phase 4A) — typed event dispatcher platform
  // services subscribe to. Touch the singleton early so the lazy
  // construction race is resolved before HealthService spins up.
  // Handler registrations land in Phase 4B+; today it just initialises
  // the bus.
  try {
    initCapabilities();
  } catch (err) {
    logger.error('Server', 'Failed to initialise capability bus:', err);
  }

  // Initialize Monitoring Service (V4 Legacy Bridge)
  HealthService.init(io).catch(err => {
      logger.error('Server', 'Failed to start monitoring service:', err);
  });
  
  // Start V4.1 Gateway Poller
  GatewayPoller.getInstance().start().catch(err => {
      logger.error('Server', 'Failed to start Gateway Poller:', err);
  });

  // #505 — periodic service↔service socket-flow sampler. Feeds the
  // network map's `observed` edges; self-contained + best-effort.
  startFlowSampler();

    // Schedule agent restarts based on config
    scheduleAgentRestart();

    // Schedule backup sync based on config
    scheduleBackup();

    // Email the operator when a new ServiceBay release lands. No-op when
    // email isn't configured. Deduped per-release via config.autoUpdate.
    scheduleUpdateNotifier();

    // Auto-purge soft-deleted services older than 7 days. Runs once at
    // boot, then every 12 hours — the deletion latency target is "you have
    // a week to undo", not "we delete on the dot".
    const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    const TRASH_PURGE_INTERVAL_MS = 12 * 60 * 60 * 1000;
    const purgeTrashAcrossNodes = async () => {
      try {
        const { listNodes: lN } = await import('./packages/backend/src/lib/nodes');
        const { ServiceManager: SM } = await import('./packages/backend/src/lib/services/ServiceManager');
        const nodes = await lN();
        for (const n of nodes) {
          try {
            await SM.purgeTrash(n.Name, { olderThanMs: TRASH_RETENTION_MS });
          } catch (e) {
            logger.warn('Server', `Trash purge failed for ${n.Name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        logger.warn('Server', `Trash purge sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    setTimeout(() => { void purgeTrashAcrossNodes(); }, 60_000);
    setInterval(() => { void purgeTrashAcrossNodes(); }, TRASH_PURGE_INTERVAL_MS);

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

    // Server identity — emitted once per (re)connect so the client can detect
    // server restarts and `setupCompleted` flips while the page is open.
    // `sessionId` is regenerated on every process start, so a delta on this
    // field across a socket reconnect means the server actually restarted
    // (vs. a transient network blip, which keeps the same id). The
    // `<ServerIdentityWatcher>` client component diff-checks the value and
    // either reloads silently (setup wizard appeared) or shows a 10s-grace
    // "Server restarted — reloading…" banner.
    void (async () => {
      try {
        const config = await getConfig();
        socket.emit('server:identity', {
          sessionId,
          setupCompleted: Boolean(config.setupCompleted),
        });
      } catch (e) {
        logger.warn('Server', `Could not emit server:identity: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

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

    // Safety lock: until the operator picks an update window, hold
    // Zincati and podman-auto-update.timer off. Closes the foot-gun
    // where a fresh install can be re-imaged mid-setup by an FCoS
    // auto-update + still-inserted USB stick. Idempotent — re-running
    // with the same disk state is a no-op. Deferred behind a short
    // delay so the agent has time to come up; we don't block boot on
    // host-side I/O.
    setTimeout(() => {
      void (async () => {
        try {
          const { getConfig } = await import('./packages/backend/src/lib/config');
          const { getExecutor } = await import('./packages/backend/src/lib/executor');
          const { applyUpdateWindow, applyLocks } = await import('./packages/backend/src/lib/updateWindow');
          const config = await getConfig();
          const win = config.updateWindow;
          const executor = getExecutor();
          if (win && win.enabled) {
            await applyUpdateWindow(executor, win);
          } else {
            await applyLocks(executor);
          }
        } catch (err) {
          logger.warn('Server', `Auto-update lock setup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }, 30_000);

    // Bootstrap-token TTL initialisation (#322). Idempotent: only
    // writes expiresAt when the install script left a hash but no
    // expiry; subsequent boots see expiresAt already set and skip.
    initBootstrapTokenExpiry().catch(err =>
      logger.warn('Server', `Bootstrap-token expiry init failed: ${err instanceof Error ? err.message : String(err)}`),
    );

    // Sync domain-reachability health checks with the configured
    // proxy hosts. Catches entries that pre-date the feature, and
    // removes orphans for hosts that were deleted while ServiceBay
    // was down. Fire-and-forget — failures degrade to "no dot" in
    // the UI, never block boot.
    (async () => {
      try {
        const { syncDomainChecks } = await import('./packages/backend/src/lib/health/domainChecks');
        await syncDomainChecks();
      } catch (err) {
        logger.warn('Server', `Domain-check sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    // Per-public-domain DNS routing health checks (15 min interval).
    // Replaces the old continuous letsdebug sweep (#letsdebug-429) —
    // uses Cloudflare DoH for a free, rate-limit-free "does my domain
    // still point at me?" signal. Boot-time sync creates a
    // `dns_routing:<domain>` check per public proxy host AND cleans
    // up any legacy `letsdebug:<domain>` checks from prior versions.
    (async () => {
      try {
        const { syncDnsRoutingChecks } = await import('./packages/backend/src/lib/health/dnsRoutingChecks');
        await syncDnsRoutingChecks();
      } catch (err) {
        logger.warn('Server', `DNS-routing sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    // LAN-IP drift detection (#318, #660). Install-time *capture* now
    // happens synchronously inside the install runner (see #660 — the
    // 60s boot-timer was race-prone). What stays here is the drift
    // safety net for long-running installs where the host's outbound
    // IP changes after install (DHCP lease, NIC swap, OS upgrade).
    // `reconcileLanIp` is idempotent: no-op when current == stored,
    // history append when it drifts. Deferred 60s so the Local agent
    // has time to come up through the socket lifecycle.
    setTimeout(() => {
      reconcileLanIp('Local').catch(err =>
        logger.warn('Server', `LAN IP drift check failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, 60_000);

    // Auto-update logic to be migrated to Executor Task
  });
});
