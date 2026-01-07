import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { Readable } from 'stream';
import * as pty from 'node-pty';
import { PodmanConnection } from './nodes';

const execAsync = promisify(exec);

export interface Executor {
  exec(command: string): Promise<{ stdout: string; stderr: string }>;
  spawn(command: string, options?: { pty?: boolean; cols?: number; rows?: number }): { stdout: Readable; stderr: Readable; promise: Promise<void> };
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export class LocalExecutor implements Executor {
  async exec(command: string) {
    return execAsync(command);
  }

  spawn(command: string, options: { pty?: boolean; cols?: number; rows?: number } = {}) {
    if (options.pty) {
      const ptyProcess = pty.spawn('bash', ['-c', command], {
        name: 'xterm-color',
        cols: options.cols || 80,
        rows: options.rows || 30,
        cwd: process.env.HOME,
        env: process.env as Record<string, string>
      });

      const stream = new Readable({
        read() {}
      });

      ptyProcess.onData((data) => {
        stream.push(data);
      });

      const promise = new Promise<void>((resolve, reject) => {
        ptyProcess.onExit(({ exitCode }) => {
          stream.push(null);
          if (exitCode === 0) resolve();
          else reject(new Error(`Command failed with code ${exitCode}`));
        });
      });

      return { stdout: stream, stderr: new Readable({ read() { this.push(null); } }), promise };
    }

    const child = spawn(command, { shell: true });
    const promise = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command failed with code ${code}`));
      });
      child.on('error', reject);
    });
    return { stdout: child.stdout, stderr: child.stderr, promise };
  }

  async readFile(filePath: string) {
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string) {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async exists(filePath: string) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string) {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async readdir(dirPath: string) {
    return fs.readdir(dirPath);
  }

  async rm(filePath: string) {
    await fs.rm(filePath, { recursive: true, force: true });
  }

  async rename(oldPath: string, newPath: string) {
    await fs.rename(oldPath, newPath);
  }
}

export class SSHExecutor implements Executor {
  private sshCommand: string;

  constructor(private connection: PodmanConnection) {
    // Parse URI: ssh://user@host:port/path
    // We need to extract user, host, port, and identity
    const uri = new URL(connection.URI);
    const user = uri.username;
    const host = uri.hostname;
    const port = uri.port;
    
    let cmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    if (connection.Identity) {
      cmd += ` -i ${connection.Identity}`;
    }
    if (port) {
      cmd += ` -p ${port}`;
    }
    
    const destination = user ? `${user}@${host}` : host;
    this.sshCommand = `${cmd} ${destination}`;
  }

  async exec(command: string) {
    // Escape single quotes in command
    const escapedCommand = command.replace(/'/g, "'\\''");
    try {
        return await execAsync(`${this.sshCommand} '${escapedCommand}'`);
    } catch (error: unknown) {
        // Enhance error message with troubleshooting hints
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = error as any;
        const stderr = err.stderr || err.message || '';
        
        let hint = '';
        if (stderr.includes('Permission denied')) {
            hint = ` (Hint: Check SSH key permissions. The private key must be readable by the container user (chmod 600). Identity File: ${this.connection.Identity})`;
        } else if (stderr.includes('Could not resolve hostname')) {
            hint = ` (Hint: The hostname could not be resolved. Check DNS or /etc/hosts.)`;
        } else if (stderr.includes('Connection refused') || stderr.includes('Connection timed out')) {
            hint = ` (Hint: Check if the SSH service is running on the target and the port is correct.)`;
        }

        if (hint) {
            err.message += hint;
        }
        throw err;
    }
  }

  spawn(command: string, options: { pty?: boolean; cols?: number; rows?: number } = {}) {
    const escapedCommand = command.replace(/'/g, "'\\''");
    
    if (options.pty) {
        // Use node-pty to run ssh with a TTY.
        // We add -t to force remote TTY allocation.
        const fullCommand = this.sshCommand.replace(/^ssh /, 'ssh -t ') + ` '${escapedCommand}'`;
        
        const ptyProcess = pty.spawn('bash', ['-c', fullCommand], {
            name: 'xterm-color',
            cols: options.cols || 80,
            rows: options.rows || 30,
            cwd: process.env.HOME,
            env: process.env as Record<string, string>
        });

        const stream = new Readable({
            read() {}
        });

        ptyProcess.onData((data) => {
            stream.push(data);
        });

        const promise = new Promise<void>((resolve, reject) => {
            ptyProcess.onExit(({ exitCode }) => {
                stream.push(null);
                if (exitCode === 0) resolve();
                else reject(new Error(`Command failed with code ${exitCode}`));
            });
        });

        return { stdout: stream, stderr: new Readable({ read() { this.push(null); } }), promise };
    }

    const fullCommand = `${this.sshCommand} '${escapedCommand}'`;
    const child = spawn(fullCommand, { shell: true });
    
    const promise = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command failed with code ${code}`));
      });
      child.on('error', reject);
    });
    
    return { stdout: child.stdout, stderr: child.stderr, promise };
  }

  async readFile(filePath: string) {
    const { stdout } = await this.exec(`cat "${filePath}"`);
    return stdout;
  }

  async writeFile(filePath: string, content: string) {
    // Use base64 to avoid escaping issues
    const base64Content = Buffer.from(content).toString('base64');
    await this.exec(`echo ${base64Content} | base64 -d > "${filePath}"`);
  }

  async exists(filePath: string) {
    try {
      await this.exec(`test -e "${filePath}"`);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(dirPath: string) {
    await this.exec(`mkdir -p ${dirPath}`);
  }

  async readdir(dirPath: string) {
    const { stdout } = await this.exec(`ls -1 ${dirPath}`);
    return stdout.split('\n').filter(Boolean);
  }

  async rm(filePath: string) {
    await this.exec(`rm -rf ${filePath}`);
  }

  async rename(oldPath: string, newPath: string) {
    await this.exec(`mv ${oldPath} ${newPath}`);
  }
}

export function getExecutor(connection?: PodmanConnection): Executor {
  if (!connection || connection.Name === 'local') { // Assuming 'local' is the reserved name for local execution
      // However, if we are in a container, 'local' might mean the container itself.
      // If the user wants to manage the HOST from the container, they should have added a connection for it.
      // If no connection is passed, we default to LocalExecutor (which is the container environment).
      return new LocalExecutor();
  }
  return new SSHExecutor(connection);
}
