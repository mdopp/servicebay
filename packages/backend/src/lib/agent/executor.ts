import { Executor } from '../interfaces';
import { AgentHandler } from './handler';
import { AgentManager } from './manager';
import { Readable } from 'stream';
import { logger } from '@/lib/logger';
import { shellQuoteAll } from '../util/shellQuote';
import { currentTraceId } from '../util/traceContext';

export class CommandError extends Error {
  code: number;
  stdout: string;
  stderr: string;

  constructor(message: string, code: number, stdout: string, stderr: string) {
    super(message);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.name = 'CommandError';
  }
}

export class AgentExecutor implements Executor {
  private agent: AgentHandler;

  constructor(nodeName: string) {
    this.agent = AgentManager.getInstance().getAgent(nodeName);
  }

  private async ensureConnected() {
    await this.agent.start();
  }

  async exec(command: string, options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    await this.ensureConnected();
    // Prefix with a trace-ID shell comment when the call originates
    // from a tracked HTTP request (#594). `: # …` is a shell noop, so
    // the agent runs the same command — but `ps -ef` on the host and
    // the agent's exec log carry the trace ID for end-to-end grep.
    const traceId = currentTraceId();
    const taggedCommand = traceId ? `: # SB_TRACE=${traceId}; ${command}` : command;
    const truncatedCmd = taggedCommand.length > 100 ? taggedCommand.substring(0, 100) + '...' : taggedCommand;
    logger.info(`Executor:${this.agent.nodeName}`, `Executing: ${truncatedCmd}`);

    const res = await this.agent.sendCommand('exec', { command: taggedCommand }, { timeoutMs: options.timeoutMs });
    // Agent returns { code, stdout, stderr }
    if (res.code !== 0) {
        throw new CommandError(`Command failed: ${command}\n${res.stderr}`, res.code, res.stdout, res.stderr);
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }

  async execArgv(argv: string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error('execArgv requires a non-empty argv array');
    }
    return this.exec(shellQuoteAll(argv), options);
  }

  /**
   * Structured-argv exec backed by the agent's `safe_exec` command
   * (#722). Sends the argv list verbatim, so the agent never shell-
   * parses the payload — there's no opportunity to inject extra
   * commands via metacharacters even if the backend is compromised.
   * The agent rejects the call unless argv[0] is on its
   * SAFE_EXEC_ALLOWLIST.
   *
   * Use this for any new call site that doesn't need shell features
   * (pipelines, redirection, glob expansion). The legacy `exec` /
   * `execArgv` paths remain available for sites that genuinely need
   * shell semantics; those are the migration target for future
   * hardening passes.
   */
  async execSafe(argv: string[], options: { timeoutMs?: number; sudo?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error('execSafe requires a non-empty argv array');
    }
    await this.ensureConnected();
    const truncatedCmd = argv.join(' ').slice(0, 100);
    // Opt-in privilege (#1713): only callers that pass `sudo: true` escalate;
    // the agent prepends `sudo -n` and still enforces the allow-list on the
    // real argv[0]. Default stays unprivileged.
    const sudo = options.sudo === true;
    logger.info(`Executor:${this.agent.nodeName}`, `safe_exec${sudo ? ' (sudo)' : ''}: ${truncatedCmd}`);
    const res = await this.agent.sendCommand('safe_exec', { argv, sudo }, { timeoutMs: options.timeoutMs });
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.code ?? -1 };
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
     try {
         await this.execArgv(['test', '-e', path]);
         return true;
     } catch {
         return false;
     }
  }

  async mkdir(path: string): Promise<void> {
      await this.execArgv(['mkdir', '-p', path]);
  }

  async readdir(path: string): Promise<string[]> {
      const { stdout } = await this.execArgv(['ls', '-1', path]);
      return stdout.trim().split('\n').filter(s => s.length > 0);
  }

  async rm(path: string): Promise<void> {
      await this.execArgv(['rm', '-rf', path]);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
      await this.execArgv(['mv', oldPath, newPath]);
  }

  spawn(command: string, options: { pty?: boolean; cols?: number; rows?: number } = {}): { stdout: Readable; stderr: Readable; promise: Promise<void> } {
    const { pty, cols, rows } = options;
    if (pty || cols || rows) {
      logger.warn(`Executor:${this.agent.nodeName}`, 'Spawn options (pty/cols/rows) are not supported yet; ignoring request.');
    }
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
        } catch (e) {
            const err = e as { stderr?: string; message: string };
            if (err.stderr) {
                stderrStream.push(err.stderr);
            }
            stderrStream.push(null);
            const wrappedErr = new Error(err.message || 'Spawn failed');
            stdoutStream.destroy(wrappedErr);
            throw wrappedErr;
        }
    })();

    return { stdout: stdoutStream, stderr: stderrStream, promise };
  }
}
