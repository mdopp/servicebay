import { Executor } from '../interfaces';
import { AgentHandler } from './handler';
import { AgentManager } from './manager';
import { Readable } from 'stream';
import { logger } from '@/lib/logger';
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
    // Append a trace-ID shell comment when the call originates from a
    // tracked HTTP request (#594). A *trailing* `# SB_TRACE=…` is ignored
    // by the shell — the command runs unchanged — but `ps -ef` on the host
    // and the agent's exec log carry the trace ID for end-to-end grep.
    // (#1877: a *leading* `: # SB_TRACE=…; <cmd>` started a comment that
    // swallowed the rest of the line, so <cmd> never ran under any trace.)
    const traceId = currentTraceId();
    const taggedCommand = traceId ? `${command}  # SB_TRACE=${traceId}` : command;
    const truncatedCmd = taggedCommand.length > 100 ? taggedCommand.substring(0, 100) + '...' : taggedCommand;
    logger.info(`Executor:${this.agent.nodeName}`, `Executing: ${truncatedCmd}`);

    const res = await this.agent.sendCommand('exec', { command: taggedCommand }, { timeoutMs: options.timeoutMs });
    // Agent returns { code, stdout, stderr }
    if (res.code !== 0) {
        throw new CommandError(`Command failed: ${command}\n${res.stderr}`, res.code, res.stdout, res.stderr);
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }

  /**
   * @deprecated Alias for {@link execSafe} (#2737). It used to be
   * `exec(shellQuoteAll(argv))` — a structured argv quoted into a shell
   * string and re-parsed on the host, i.e. one quoting layer in which a
   * filename with a space or a `$` could mean something else. It now
   * delegates straight to the agent's `safe_exec`, so nothing is
   * shell-parsed. `EXEC_ARGV_MAX = 0` in `scripts/check-invariants.ts`
   * keeps the call-site count at zero; the method survives only so
   * out-of-tree `Executor` implementations keep compiling.
   */
  async execArgv(argv: string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await this.execSafe(argv, options);
    return { stdout, stderr };
  }

  /**
   * Structured-argv exec backed by the agent's `safe_exec` command
   * (#722). Sends the argv list verbatim, so the agent never shell-
   * parses the payload — there's no opportunity to inject extra
   * commands via metacharacters even if the backend is compromised.
   * The agent rejects the call unless argv[0] is on its
   * SAFE_EXEC_ALLOWLIST.
   *
   * This is *the* exec path for argv (#2737). `exec()` with a shell
   * string is reserved for the handful of sites that genuinely need
   * shell semantics (pipelines, redirection, `command -v`), and each of
   * those carries a comment saying so.
   *
   * `check` (default `true`) mirrors `exec()`: a non-zero exit throws
   * `CommandError`. Callers that want to inspect the exit code instead
   * pass `check: false` — the historic `execSafe` contract.
   */
  async execSafe(argv: string[], options: { timeoutMs?: number; sudo?: boolean; check?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error('execSafe requires a non-empty argv array');
    }
    await this.ensureConnected();
    const truncatedCmd = argv.join(' ').slice(0, 100);
    // Opt-in privilege (#1713): only callers that pass `sudo: true` escalate;
    // the agent prepends `sudo -n` and still enforces the allow-list on the
    // real argv[0]. Default stays unprivileged.
    const sudo = options.sudo === true;
    // Trace-ID parity with `exec()` (#594): the shell path could smuggle the ID
    // into the command line as a trailing comment; argv is sent verbatim, so the
    // ID rides the agent's exec log line instead of the command.
    const traceId = currentTraceId();
    logger.info(
      `Executor:${this.agent.nodeName}`,
      `safe_exec${sudo ? ' (sudo)' : ''}: ${truncatedCmd}${traceId ? `  # SB_TRACE=${traceId}` : ''}`,
    );
    const res = await this.agent.sendCommand('safe_exec', { argv, sudo }, { timeoutMs: options.timeoutMs });
    const result = { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.code ?? -1 };
    if (options.check !== false && result.code !== 0) {
      throw new CommandError(`Command failed: ${argv.join(' ')}\n${result.stderr}`, result.code, result.stdout, result.stderr);
    }
    return result;
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
         await this.execSafe(['test', '-e', path]);
         return true;
     } catch {
         return false;
     }
  }

  async mkdir(path: string): Promise<void> {
      await this.execSafe(['mkdir', '-p', path]);
  }

  async readdir(path: string): Promise<string[]> {
      const { stdout } = await this.execSafe(['ls', '-1', path]);
      return stdout.trim().split('\n').filter(s => s.length > 0);
  }

  async rm(path: string): Promise<void> {
      await this.execSafe(['rm', '-rf', path]);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
      await this.execSafe(['mv', oldPath, newPath]);
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
