import { Executor } from '../interfaces';
import { AgentHandler } from './handler';
import { AgentManager } from './manager';
import { Readable } from 'stream';
import { logger } from '@/lib/logger';

export class AgentExecutor implements Executor {
  private agent: AgentHandler;

  constructor(nodeName: string) {
    this.agent = AgentManager.getInstance().getAgent(nodeName);
  }

  private async ensureConnected() {
    await this.agent.start();
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string }> {
    await this.ensureConnected();
    const truncatedCmd = command.length > 100 ? command.substring(0, 100) + '...' : command;
    logger.info(`Executor:${this.agent.nodeName}`, `Executing: ${truncatedCmd}`);
    
    const res = await this.agent.sendCommand('exec', { command });
    // Agent returns { code, stdout, stderr }
    if (res.code !== 0) {
        // Mimic child_process.exec error
        const err = new Error(`Command failed: ${command}\n${res.stderr}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).code = res.code;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).stdout = res.stdout;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).stderr = res.stderr;
        throw err;
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }

  async readFile(path: string): Promise<string> {
    await this.ensureConnected();
    const res = await this.agent.sendCommand('read_file', { path });
    return res.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureConnected();
    await this.agent.sendCommand('write_file', { path, content });
  }

  async exists(path: string): Promise<boolean> {
     // Use exec for now
     try {
         await this.exec(`test -e "${path}"`);
         return true;
     } catch {
         return false;
     }
  }

  async mkdir(path: string): Promise<void> {
      await this.exec(`mkdir -p "${path}"`);
  }

  async readdir(path: string): Promise<string[]> {
      const { stdout } = await this.exec(`ls -1 "${path}"`);
      return stdout.trim().split('\n').filter(s => s.length > 0);
  }

  async rm(path: string): Promise<void> {
      await this.exec(`rm -rf "${path}"`);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
      await this.exec(`mv "${oldPath}" "${newPath}"`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  spawn(command: string, options: { pty?: boolean; cols?: number; rows?: number } = {}): { stdout: Readable; stderr: Readable; promise: Promise<void> } {
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    
    const promise = (async () => {
        try {
            const { stdout, stderr } = await this.exec(command);
            stdoutStream.push(stdout);
            stdoutStream.push(null);
            if (stderr) {
                stderrStream.push(stderr);
            }
            stderrStream.push(null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            if (e.stderr) {
                stderrStream.push(e.stderr);
            }
            stderrStream.push(null);
            const err = new Error(e.message || 'Spawn failed');
            stdoutStream.destroy(err);
            throw err;
        }
    })();

    return { stdout: stdoutStream, stderr: stderrStream, promise };
  }
}
