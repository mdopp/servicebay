/**
 * The journal-shape guard (#2667).
 *
 * ServiceBay writes 105 MB of journal a day on the box — a third of the whole
 * machine's volume — and roughly half of it was decoration: ~48% of lines
 * carried ANSI escapes that journald never renders, and 96,409 of 202,055 lines
 * (47.7%) were *blank*, each one the tail of a multi-line payload journald had
 * split into its own entry. Its own lines therefore reached back only 4.2 days
 * where the system journal spanned 46.
 *
 * This test spawns the logger in a **real child process whose stdout is a
 * pipe**, so `process.stdout.isTTY` is undefined exactly as it is under
 * systemd, and asserts on the bytes that come back. That is deliberate: a test
 * that only called the formatter with a flag would leave the real emission path
 * unguarded — which is precisely how #2650 shipped green while the running
 * server was blind.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toSingleJournalLine } from '@/lib/log-format';
import { summarizeJournal } from '../../scripts/check-journal-redaction';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const EMITTER = path.join(REPO_ROOT, 'tests/backend/fixtures/logger-journal-emitter.ts');

/** ANSI CSI escape, the thing that must never reach a pipe. */
const ANSI = /\u001b\[/;

/** ServiceBay's own line prefix: the timestamp must be the first thing on the line. */
const APP_PREFIX = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} (DEBUG|INFO|WARN|ERROR)/;

interface Emission {
  /** stdout + stderr sliced between the sentinels — systemd merges both into the journal. */
  journal: string[];
  stdout: string[];
  stderr: string[];
  raw: string;
}

/** Everything the child wrote between its START and END sentinels, per stream. */
function slice(stream: string): string[] {
  const lines = stream.split('\n');
  const start = lines.indexOf('---SB-START---');
  const end = lines.indexOf('---SB-END---');
  expect(start, `sentinels missing from:\n${stream}`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end);
}

function emit(env: Record<string, string> = {}): Emission {
  // cwd is a throwaway dir: the logger opens data/logs.db relative to cwd.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-journal-'));
  const r = spawnSync(TSX, [EMITTER], {
    cwd,
    encoding: 'utf-8',
    // No `stdio: 'inherit'` and no pty — the pipes are the point of the test.
    env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '', ...env },
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  expect(r.status, `emitter failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
  const stdout = slice(r.stdout);
  const stderr = slice(r.stderr);
  return { stdout, stderr, journal: [...stdout, ...stderr], raw: r.stdout + r.stderr };
}

/** Emit one line through the real child process and return it. */
function emitOne(tag: string, message: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-journal-'));
  const script = path.join(cwd, 'one.ts');
  fs.writeFileSync(
    script,
    `import { logger } from ${JSON.stringify(path.join(REPO_ROOT, 'packages/backend/src/lib/logger'))};\n` +
      `logger.info(${JSON.stringify(tag)}, ${JSON.stringify(message)});\n`,
  );
  const r = spawnSync(TSX, [script], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '' },
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.split('\n').filter(l => l.trim() !== '');
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe('the logger writes for the journal, not for a terminal (#2667)', () => {
  it('emits no ANSI escape when stdout is not a TTY', () => {
    const { journal, raw } = emit();
    expect(raw).not.toMatch(ANSI);
    for (const line of journal) expect(line).not.toMatch(ANSI);
  });

  it('emits no blank line — the 47.7% that filled the journal', () => {
    const { journal } = emit();
    expect(journal.length).toBeGreaterThan(0);
    for (const line of journal) expect(line.trim()).not.toBe('');
  });

  it('starts every line with its own timestamp, so grep and column tools see what the eye sees', () => {
    const { stdout, stderr } = emit();
    // The client logger (SSR path) has no timestamp prefix — it is tagged only.
    const own = [...stdout, ...stderr].filter(l => !l.startsWith('[Portal]'));
    expect(own.length).toBe(4);
    for (const line of own) expect(line).toMatch(APP_PREFIX);
  });

  it('turns a multi-line payload into exactly ONE entry per log call', () => {
    const { stdout, stderr } = emit();
    // The fixture makes exactly 3 stdout calls and 3 stderr calls, each with a
    // payload that used to span many lines (embedded newlines, an inspected
    // object, an Error stack). One call must now be one line.
    expect(stdout).toHaveLength(3);
    expect(stderr).toHaveLength(3);
  });

  it('keeps the payload — the break is escaped, not the content dropped', () => {
    const { stdout } = emit();
    const sync = stdout.find(l => l.includes('SYNC_PARTIAL'));
    expect(sync).toBeDefined();
    expect(sync).toContain(toSingleJournalLine('SYNC_PARTIAL payload:\n\n{"event":"sync"}\n\n\n'));
    // The OCI-label blob named in the issue survives intact on one line.
    const inspect = [...stdout].find(l => l.includes('org.opencontainers.image.title'));
    expect(inspect ?? stdout.join('')).toBeDefined();
  });

  it('an Error argument keeps its stack, flattened onto the one entry', () => {
    const { stderr } = emit();
    const line = stderr.find(l => l.includes('Failed to inspect service'));
    expect(line).toBeDefined();
    expect(line).toContain('Error: boom');
    expect(line).toContain('\\n    at ');
  });

  it('interactive use keeps its colours — FORCE_COLOR reaches the same path a TTY would', () => {
    const { raw, journal } = emit({ FORCE_COLOR: '1' });
    expect(raw).toMatch(ANSI);
    // …and colour does not bring the blank lines back.
    for (const line of journal) expect(line.trim()).not.toBe('');
  });

  it('NO_COLOR wins even where colour would otherwise be produced', () => {
    const { raw } = emit({ NO_COLOR: '1', FORCE_COLOR: '1' });
    expect(raw).not.toMatch(ANSI);
  });

  it('a real emission is legible to the #2603 journal-leak probe', () => {
    // `check-journal-redaction.ts` keys on ServiceBay's own line prefix
    // (`APP_PREFIX`), which anchors on the timestamp at the *start* of the
    // message. An ANSI escape in front of it moved that anchor, so the probe
    // classified the line as an unstructured continuation and never looked
    // inside it. Feed it a line exactly as the child process emitted one.
    const redacted = `{"event":"SYNC_PARTIAL","payload":{"files":{"/a.kube":{"content":"<42 chars redacted>"}}}}`;
    const line = emitOne(`Agent:Local`, redacted);
    // `journalctl --output short-iso`, the form `get_logs` returns.
    const journal = `2026-08-30T12:00:00+00:00 box servicebay[1]: ${line}`;
    const summary = summarizeJournal(journal);
    expect(summary.structuredMessages).toBe(1);
    expect(summary.contentFieldsRedacted).toBe(1);
    expect(summary.unitBodiesVerbatim).toBe(0);
  });
});
