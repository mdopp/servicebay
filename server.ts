import './scripts/load-env';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
import * as pty from 'node-pty';
import os from 'os';
import { setUpdaterIO } from './src/lib/updater';
// Monitoring init moved to Agent logic in V4
import { MonitoringService } from './src/lib/monitoring/service';
import { agentManager } from './src/lib/agent/manager';
import { listNodes } from './src/lib/nodes';
import { AgentEvent } from './src/lib/agent/handler';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();


// Global PTY state
interface PtySession {
  process: pty.IPty;
  history: string;
  lastActive: number;
}

const sessions = new Map<string, PtySession>();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new Server(server);
  
  // --- V4 Agent Event Bus Integration ---
  agentManager.on('agent:connected', (nodeName: string) => {
      io.emit('node:status', { node: nodeName, status: 'connected' });
  });
  agentManager.on('agent:disconnected', (nodeName: string) => {
      io.emit('node:status', { node: nodeName, status: 'disconnected' });
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
      nodes.forEach(node => {
         const agent = agentManager.getAgent(node.Name);
         // Forward events
         agent.on('event', (e: AgentEvent) => broadcastAgentEvent(node.Name, e));
         
         // Start connection in background
         agent.start().catch(err => {
             console.error(`[Agent:${node.Name}] Failed to auto-connect:`, err.message);
         });
      });
  });

  // Pass IO to updater
  setUpdaterIO(io);

  // Initialize Monitoring Service (V4 Legacy Bridge)
  MonitoringService.init(io).catch(err => {
      console.error('Failed to start monitoring service:', err);
  });



  // Function to spawn a PTY
  const ensurePty = async (id: string, cols: number = 80, rows: number = 30) => {
    if (sessions.has(id)) {
        const session = sessions.get(id)!;
        // Resize existing session if dimensions differ and are valid
        if (cols > 0 && rows > 0) {
            try {
                session.process.resize(cols, rows);
            } catch (e) {
                console.error(`Error resizing existing session ${id}:`, e);
            }
        }
        return session;
    }

    let shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
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
            console.error('Invalid container ID');
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
                console.error(`Failed to setup remote container terminal for ${nodeName}:`, e);
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
            console.error('Failed to resolve node connection', e);
        }
    }
    
    console.log(`Spawning PTY: ${shell} ${args.join(' ')}`);

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 30,
      cwd: process.env.HOME,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: { ...process.env, TERM: 'xterm-256color' } as any
    });

    console.log(`Spawned new PTY process for ${id} (PID: ${ptyProcess.pid})`);

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
      console.log(`PTY process ${id} exited with code ${code}`);
      io.to(id).emit('output', `\r\n\x1b[31m>>> Session exited with code ${code}\x1b[0m\r\n`);
      sessions.delete(id);
    });

    return session;
  };

  // Initialize host PTY immediately
  ensurePty('host').catch(console.error);

  io.on('connection', (socket) => {
    console.log('Client connected');
    
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
        
        console.log(`Client joining terminal ${id} with dims ${cols}x${rows}`);
        socket.join(id);
        try {
            const session = await ensurePty(id, cols, rows);
            socket.emit('history', session.history);
        } catch (e) {
            console.error('Failed to join terminal:', e);
            socket.emit('output', '\r\n\x1b[31m>>> Failed to join terminal session.\x1b[0m\r\n');
        }
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

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  // Cleanup inactive container sessions
  setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions.entries()) {
          if (id !== 'host' && now - session.lastActive > 1000 * 60 * 5) { // 5 mins inactivity
              console.log(`Killing inactive session ${id}`);
              session.process.kill();
              sessions.delete(id);
          }
      }
  }, 60000);

  server.listen(port, async () => {
    console.log(`> Ready on http://${hostname}:${port}`);

    // Auto-update logic to be migrated to Executor Task
  });
});
