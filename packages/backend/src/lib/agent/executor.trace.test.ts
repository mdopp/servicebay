import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

// Capture the command line the agent is asked to run.
const sent: { command: string }[] = [];

const stubHandler = {
  nodeName: 'Local',
  start: vi.fn(async () => {}),
  // Simulate the agent: actually run the command line through a real shell
  // (the agent runs it via SSH on the host), so a wrapper that comments out
  // the command would show up as empty stdout / exit 0 here too.
  sendCommand: vi.fn(async (_op: string, payload: { command: string }) => {
    sent.push({ command: payload.command });
    try {
      const stdout = execFileSync('/bin/sh', ['-c', payload.command], {
        encoding: 'utf8',
      });
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
import { runWithTrace } from '../util/traceContext';

describe('AgentExecutor trace wrapper (#1877)', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('runs the real command and returns its stdout when inside a trace frame', async () => {
    const exec = new AgentExecutor('Local');
    const { stdout } = await runWithTrace(
      () => exec.exec('echo hello-traced'),
      'deadbeef',
    );
    // The command actually executed — not swallowed by a leading `: #` comment.
    expect(stdout.trim()).toBe('hello-traced');
  });

  it('propagates the real exit code under a trace frame', async () => {
    const exec = new AgentExecutor('Local');
    await expect(
      runWithTrace(() => exec.exec('exit 3'), 'cafef00d'),
    ).rejects.toMatchObject({ code: 3 });
  });

  it('keeps the SB_TRACE tag greppable on the command line', async () => {
    const exec = new AgentExecutor('Local');
    await runWithTrace(() => exec.exec('echo hi'), 'abc12345');
    expect(sent[0].command).toContain('SB_TRACE=abc12345');
    // Tag is a trailing comment, not a leading one that swallows the command.
    expect(sent[0].command).toMatch(/echo hi\s+# SB_TRACE=abc12345$/);
  });

  it('does not tag the command outside a trace frame', async () => {
    const exec = new AgentExecutor('Local');
    const { stdout } = await exec.exec('echo plain');
    expect(stdout.trim()).toBe('plain');
    expect(sent[0].command).toBe('echo plain');
    expect(sent[0].command).not.toContain('SB_TRACE');
  });
});
