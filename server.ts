import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
import * as pty from 'node-pty';
import os from 'os';
import schedule from 'node-schedule';
import { getConfig } from './src/lib/config';
import { checkForUpdates, performUpdate } from './src/lib/updater';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;
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

  // Function to spawn a PTY
  const ensurePty = (id: string) => {
    if (sessions.has(id)) return sessions.get(id)!;

    let shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    let args: string[] = [];

    if (id.startsWith('container:')) {
        const containerId = id.split(':')[1];
        if (!containerId) {
            console.error('Invalid container ID');
            return sessions.get('host')!; // Fallback to host or handle error
        }
        shell = 'podman';
        // Try to use bash if available, otherwise sh. Pass TERM env var.
        args = ['exec', '-it', '-e', 'TERM=xterm-256color', containerId, 'sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi'];
    }
    
    console.log(`Spawning PTY: ${shell} ${args.join(' ')}`);

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
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
  ensurePty('host');

  io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.on('join', (id: string) => {
        console.log(`Client joining terminal ${id}`);
        socket.join(id);
        const session = ensurePty(id);
        socket.emit('history', session.history);
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

    // Initialize Auto-Update Scheduler
    try {
      const config = await getConfig();
      if (config.autoUpdate.enabled) {
        console.log(`Scheduling auto-updates with schedule: ${config.autoUpdate.schedule}`);
        schedule.scheduleJob(config.autoUpdate.schedule, async () => {
          console.log('Running scheduled update check...');
          const status = await checkForUpdates();
          if (status.hasUpdate && status.latest) {
            console.log(`Update found: ${status.latest.version}. Installing...`);
            await performUpdate(status.latest.version);
          } else {
            console.log('No updates found.');
          }
        });
      }
    } catch (e) {
      console.error('Failed to initialize auto-updater:', e);
    }
  });
});
