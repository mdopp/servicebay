import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * #2737 — `execArgv` used to be `exec(shellQuoteAll(argv))`: the argv was
 * quoted into a shell string and re-parsed on the host. Every argv call site
 * now goes to `execSafe`, which hands the list to the agent's `safe_exec`
 * verbatim. These tests pin the property that made the change worth doing:
 * an argument containing spaces and `$` arrives at the child process
 * unmodified, with no shell in between.
 */

/** argv lists the fake agent was asked to run. */
const sent: string[][] = [];

const stubHandler = {
  nodeName: 'Local',
  start: vi.fn(async () => {}),
  // Simulate the agent's safe_exec: run the argv through a real child process
  // WITHOUT a shell, exactly as `_executor.execute(argv)` does on the box.
  sendCommand: vi.fn(async (op: string, payload: { argv: string[] }) => {
    expect(op).toBe('safe_exec');
    sent.push([...payload.argv]);
    try {
      const stdout = execFileSync(payload.argv[0], payload.argv.slice(1), { encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }),
};

vi.mock('./manager', () => ({
  AgentManager: {
    getInstance: () => ({ getAgent: () => stubHandler }),
  },
}));

import { AgentExecutor } from './executor';

/** A filename that a shell would mangle: word-split on the spaces, and
 *  `$HOME` / `$(id)` expanded or executed. */
const NASTY = 'my backup $HOME $(id) file.tar';

describe('AgentExecutor.execSafe — argv reaches the child unmodified (#2737)', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('sends the argv verbatim — spaces and `$` are neither quoted nor split', async () => {
    const exec = new AgentExecutor('Local');
    await exec.execSafe(['/bin/echo', '-n', NASTY]);
    expect(sent[0]).toEqual(['/bin/echo', '-n', NASTY]);
  });

  it('the child process receives the argument byte-for-byte', async () => {
    const exec = new AgentExecutor('Local');
    const { stdout } = await exec.execSafe(['/bin/echo', '-n', NASTY]);
    // No word-splitting (one argument, still one), no `$HOME` expansion and no
    // command substitution: the literal text comes back.
    expect(stdout).toBe(NASTY);
  });

  it('the deprecated execArgv alias has the same no-shell behaviour', async () => {
    const exec = new AgentExecutor('Local');
    const { stdout } = await exec.execArgv(['/bin/echo', '-n', NASTY]);
    expect(sent[0]).toEqual(['/bin/echo', '-n', NASTY]);
    expect(stdout).toBe(NASTY);
  });

  it('throws CommandError on a non-zero exit, like exec() does', async () => {
    const exec = new AgentExecutor('Local');
    await expect(exec.execSafe(['/bin/false'])).rejects.toMatchObject({ name: 'CommandError', code: 1 });
  });

  it('reports the exit code instead of throwing when check is false', async () => {
    const exec = new AgentExecutor('Local');
    const res = await exec.execSafe(['/bin/false'], { check: false });
    expect(res.code).toBe(1);
  });

  it('refuses an empty argv', async () => {
    const exec = new AgentExecutor('Local');
    await expect(exec.execSafe([])).rejects.toThrow(/non-empty argv/);
  });
});
