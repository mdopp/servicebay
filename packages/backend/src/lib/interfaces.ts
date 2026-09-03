
import { Readable } from 'stream';

export interface Executor {
  exec(command: string, options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  /**
   * @deprecated Alias for `execSafe` (#2737). No call sites remain
   * (`EXEC_ARGV_MAX = 0` in `scripts/check-invariants.ts`).
   */
  execArgv(argv: string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  /**
   * Execute a pre-tokenized argv via the agent's `safe_exec`: the list is sent
   * verbatim and never shell-parsed, so a space or a `$` in an argument reaches
   * the child process unchanged. This is *the* exec path for argv; `exec()` is
   * only for the few sites that genuinely need shell semantics.
   *
   * A non-zero exit throws `CommandError` (like `exec()`); pass `check: false`
   * to inspect `code` instead.
   */
  execSafe(argv: string[], options?: { timeoutMs?: number; sudo?: boolean; check?: boolean }): Promise<{ stdout: string; stderr: string; code: number }>;
  spawn(command: string, options?: { pty?: boolean; cols?: number; rows?: number }): { stdout: Readable; stderr: Readable; promise: Promise<void> };
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}
