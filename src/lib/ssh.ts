import * as pty from 'node-pty';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SSH_DIR } from './dirs';

const execAsync = promisify(exec);

export async function verifySSHConnection(host: string, port: number, user: string, identityFile: string): Promise<boolean> {
  try {
    const cmd = `ssh -i "${identityFile}" -p ${port} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${user}@${host} exit`;
    await execAsync(cmd);
    return true;
  } catch (e) {
    return false;
  }
}

export async function checkTcpConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

export async function setupSSHKey(host: string, port: number, user: string, pass: string): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  
  // Ensure we have a public key
  const sshDir = SSH_DIR;
  const pubKeyPath = path.join(sshDir, 'id_rsa.pub');
  const privKeyPath = path.join(sshDir, 'id_rsa');
  
  if (!fs.existsSync(pubKeyPath)) {
    logs.push(`No SSH key found at ${pubKeyPath}. Generating one...`);
    if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    
    try {
        // Generate key if missing (non-interactive)
        await execAsync(`ssh-keygen -t rsa -b 4096 -f "${privKeyPath}" -N ""`);
        logs.push('SSH key generated.');
    } catch (e) {
        logs.push(`Failed to generate SSH key: ${e}`);
        return { success: false, logs };
    }
  }

  return new Promise((resolve) => {
    const cmd = 'ssh-copy-id';
    // Pass StrictHostKeyChecking=no to avoid the yes/no prompt for known_hosts
    // Explicitly use the generated identity file (-i)
    const args = ['-i', pubKeyPath, '-p', String(port), '-o', 'StrictHostKeyChecking=no', `${user}@${host}`];
    
    logs.push(`Running: ${cmd} ${args.join(' ')}`);

    // Ensure HOME/.ssh exists because ssh-copy-id uses it for temporary files (mktemp -d ~/.ssh/...)
    // In minimal containers running as root, /root/.ssh might not exist.
    const homeDir = process.env.HOME || '/root';
    const homeSshDir = path.join(homeDir, '.ssh');
    try {
        if (!fs.existsSync(homeSshDir)) {
            fs.mkdirSync(homeSshDir, { recursive: true, mode: 0o700 });
            logs.push(`Created missing directory: ${homeSshDir}`);
        }
    } catch (e) {
        logs.push(`Warning: Could not create ${homeSshDir}: ${e}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = { ...process.env } as any;

    const proc = pty.spawn(cmd, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: env
    });

    let buffer = '';
    let sentPassword = false;

    proc.onData((data) => {
      buffer += data;
      // Clean up logs a bit (remove control chars if possible, but simple trim is ok for now)
      // logs.push(`[PTY]: ${data.trim()}`); 
      
      // Handle prompts
      if ((buffer.includes('password:') || buffer.includes('Password:')) && !sentPassword) {
        logs.push('Password prompt detected. Sending password...');
        proc.write(pass + '\n');
        sentPassword = true;
        buffer = ''; // Clear buffer
      }
      
      // Fallback for fingerprint if StrictHostKeyChecking=no doesn't work for some reason
      if (buffer.includes('continue connecting (yes/no')) {
         logs.push('Fingerprint prompt detected. Sending yes...');
         proc.write('yes\n');
         buffer = '';
      }
    });

    proc.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        logs.push('ssh-copy-id completed successfully.');
        resolve({ success: true, logs });
      } else {
        logs.push(`ssh-copy-id failed with exit code ${exitCode}`);
        // If we failed, maybe we can capture the last buffer as error
        if (buffer.trim()) logs.push(`Last output: ${buffer.trim()}`);
        resolve({ success: false, logs });
      }
    });
  });
}
