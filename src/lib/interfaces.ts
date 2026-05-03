
import { Readable } from 'stream';

export interface Executor {
  exec(command: string, options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  /**
   * Execute a command from a pre-tokenized argv. Each element is shell-quoted
   * before being concatenated, so callers do not need to escape anything.
   * Prefer this over `exec()` when any element is user-supplied.
   */
  execArgv(argv: string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  spawn(command: string, options?: { pty?: boolean; cols?: number; rows?: number }): { stdout: Readable; stderr: Readable; promise: Promise<void> };
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}
