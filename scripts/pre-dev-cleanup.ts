import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

type ProcessEntry = {
  pid: number;
  ppid: number;
  user: string;
  command: string;
};

type Victim = {
  pid: number;
  reason: string;
  command: string;
};

const LOG_PREFIX = '[PreDevCleanup]';
const workspaceRoot = path.resolve(__dirname, '..');
const username = os.userInfo().username;
const EXACT_PATTERNS = [
  {
    test: (command: string) => command.includes('podman events --format json --filter type=container'),
    reason: 'Podman events watcher'
  },
  {
    test: (command: string) => command.includes('podman events --format json'),
    reason: 'Podman events watcher'
  }
];
const WORKSPACE_KEYWORDS = ['node', 'npm', 'next', 'sh', 'python', 'uv', 'pet'];

if (process.platform !== 'win32') {
  runCleanup();
} else {
  console.log(`${LOG_PREFIX} Skipping cleanup on Windows.`);
}

function runCleanup() {
  const processes = listProcesses();
  if (processes.length === 0) {
    console.log(`${LOG_PREFIX} No processes found for cleanup.`);
    return;
  }

  const victims = processes
    .filter(proc => proc.user === username && proc.pid !== process.pid)
    .map(proc => {
      const reason = classify(proc.command);
      if (!reason) return null;
      const victim: Victim = { pid: proc.pid, reason, command: proc.command };
      return victim;
    })
    .filter((entry): entry is Victim => Boolean(entry));

  if (victims.length === 0) {
    console.log(`${LOG_PREFIX} No leftover ServiceBay processes found.`);
    return;
  }

  victims.forEach(victim => {
    terminate(victim.pid, victim.reason);
  });
}

function listProcesses(): ProcessEntry[] {
  const psResult = spawnSync('ps', ['-eo', 'pid=,ppid=,user=,command='], { encoding: 'utf-8' });
  if (psResult.error) {
    console.error(`${LOG_PREFIX} Failed to inspect processes:`, psResult.error);
    return [];
  }
  if (psResult.status && psResult.status !== 0) {
    const stderr = psResult.stderr ? psResult.stderr.toString().trim() : '';
    console.error(`${LOG_PREFIX} ps exited with code ${psResult.status}${stderr ? `: ${stderr}` : ''}`);
    return [];
  }

  return psResult.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      const entry: ProcessEntry = {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        user: match[3],
        command: match[4]
      };
      return entry;
    })
    .filter((entry): entry is ProcessEntry => Boolean(entry));
}

function classify(command: string): string | null {
  if (!command) return null;
  if (command.includes('pre-dev-cleanup')) return null;

  for (const pattern of EXACT_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.reason;
    }
  }

  if (command.includes(workspaceRoot)) {
    const keyword = WORKSPACE_KEYWORDS.find(value => command.includes(value));
    if (keyword) {
      return `Workspace ${keyword} process`;
    }
  }

  return null;
}

function terminate(pid: number, reason: string) {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`${LOG_PREFIX} Sent SIGTERM to PID ${pid} (${reason}).`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') return;
    console.error(`${LOG_PREFIX} Failed to terminate PID ${pid}:`, err);
  }
}
