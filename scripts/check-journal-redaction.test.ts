import { describe, it, expect } from 'vitest';
import { reassembleMessages, summarizeJournal, parseArgs } from './check-journal-redaction';

// Every fixture below is synthetic. `PLACEHOLDER-NOT-A-REAL-SECRET` is the only
// "secret" that ever appears here — no value from any live box belongs in a
// committed fixture (CLAUDE.md, secret hygiene).
const QUADLET_BODY = [
  '[Unit]',
  'Description=ServiceBay Rootless Management Interface',
  '',
  '[Container]',
  'Image=ghcr.io/mdopp/servicebay:latest',
  'Environment=SERVICEBAY_PASSWORD=PLACEHOLDER-NOT-A-REAL-SECRET',
].join('\n');

const QUADLET_PATH = '/var/home/core/.config/containers/systemd/servicebay.container';

function syncLine(files: Record<string, { content: string }>): string {
  return JSON.stringify({ event: 'SYNC_PARTIAL', payload: { files }, runId: 'run-1', sessionId: 'servicebay-x' });
}

/** One journal entry as `journalctl --output short-iso` renders it. */
function entry(message: string, identifier = 'servicebay'): string {
  return `2026-08-25T07:41:09+00:00 box ${identifier}[1]: ${message}`;
}

/** ServiceBay's own log prefix, which starts a new logical message. */
function app(source: string, body: string): string {
  return `2026-08-25 07:41:09.327 INFO  [${source}] ${body}`;
}

describe('reassembleMessages', () => {
  it('rejoins the 8192-byte chunks conmon splits one long line into', () => {
    const long = 'x'.repeat(8192);
    const journal = [entry(app('Agent:Local', long)), entry('y'.repeat(8192)), entry('z'.repeat(10))].join('\n');
    const msgs = reassembleMessages(journal);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].chunks).toBe(3);
    expect(msgs[0].body).toHaveLength(8192 + 8192 + 10);
    expect(msgs[0].source).toBe('Agent:Local');
  });

  it('starts a new message at the next ServiceBay log prefix', () => {
    const journal = [entry(app('Agent:Local', 'first')), entry(app('Server', 'second'))].join('\n');
    expect(reassembleMessages(journal).map(m => m.source)).toEqual(['Agent:Local', 'Server']);
  });

  it('keeps the systemd identifier so podman/systemd lines stay distinguishable', () => {
    const journal = [entry(app('Server', 'a')), entry(app('Server', 'b'), 'podman')].join('\n');
    expect(reassembleMessages(journal).map(m => m.identifier)).toEqual(['servicebay', 'podman']);
  });

  it('keeps a line that carries no ServiceBay prefix at all', () => {
    const msgs = reassembleMessages(entry('Starting ServiceBay…', 'systemd'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBeNull();
  });
});

describe('summarizeJournal', () => {
  it('flags a quadlet body that reached the journal verbatim', () => {
    const journal = entry(app('Agent:Local', syncLine({ [QUADLET_PATH]: { content: QUADLET_BODY } })));
    const s = summarizeJournal(journal);
    expect(s.unitBodiesVerbatim).toBe(1);
    expect(s.contentFieldsVerbatim).toBe(1);
    expect(s.contentFieldsRedacted).toBe(0);
    expect(s.findings[0].keyPath).toBe(`payload.files.${QUADLET_PATH}.content`);
    expect(s.findings[0].event).toBe('SYNC_PARTIAL');
  });

  it('never reports the content itself — only its path and length', () => {
    const journal = entry(app('Agent:Local', syncLine({ [QUADLET_PATH]: { content: QUADLET_BODY } })));
    const printed = JSON.stringify(summarizeJournal(journal));
    expect(printed).not.toContain('PLACEHOLDER-NOT-A-REAL-SECRET');
    expect(printed).not.toContain('[Container]');
    expect(summarizeJournal(journal).findings[0].length).toBe(QUADLET_BODY.length);
  });

  it('passes the redacted shape #2603 produces', () => {
    const journal = entry(app('Agent:Local', syncLine({ [QUADLET_PATH]: { content: `<${QUADLET_BODY.length} chars redacted>` } })));
    const s = summarizeJournal(journal);
    expect(s.unitBodiesVerbatim).toBe(0);
    expect(s.contentFieldsRedacted).toBe(1);
    expect(s.findings).toEqual([]);
  });

  it('finds the leak across conmon chunk boundaries, not just within one entry', () => {
    // The real box splits a ~160 KB sync at 8192 bytes; a line-wise grep sees
    // only fragments and mis-measures the payload.
    const line = syncLine({ [QUADLET_PATH]: { content: QUADLET_BODY }, '/pad': { content: 'p'.repeat(9000) } });
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += 8192) chunks.push(line.slice(i, i + 8192));
    expect(chunks.length).toBeGreaterThan(1);
    const journal = chunks.map((c, i) => entry(i === 0 ? app('Agent:Local', c) : c)).join('\n');
    expect(summarizeJournal(journal).unitBodiesVerbatim).toBe(1);
  });

  it('ignores container output that merely looks quadlet-shaped', () => {
    // Prose or container stdout mentioning `[Container]` is not a `content`
    // field in a structured agent payload, so it must not turn the probe red.
    const journal = [
      entry(app('Agent:Local', `Wrote a unit with an [Container] section and Environment=FOO=bar`)),
      entry(app('Server', 'SYNC_PARTIAL from Local | Keys: files')),
      entry(`[Container] straight from a container's stdout`, 'podman'),
    ].join('\n');
    const s = summarizeJournal(journal);
    expect(s.unitBodiesVerbatim).toBe(0);
    expect(s.findings).toEqual([]);
  });

  it('walks nested payloads, so a content field one level deeper is still caught', () => {
    const nested = JSON.stringify({
      event: 'SYNC_PARTIAL',
      payload: { nodes: [{ files: { [QUADLET_PATH]: { content: QUADLET_BODY } } }] },
    });
    expect(summarizeJournal(entry(app('Agent:Local', nested))).unitBodiesVerbatim).toBe(1);
  });

  it('timestamps the leak window, so history is distinguishable from a live leak', () => {
    // The real distinction on 2026-08-25: entries written before the box pulled
    // the image carrying #2603 leaked; every entry after it was redacted. A
    // probe that reports only a count cannot tell those two apart.
    const leaking = syncLine({ [QUADLET_PATH]: { content: QUADLET_BODY } });
    const journal = [
      `2026-08-25T07:41:09+00:00 box servicebay[1]: 2026-08-25 07:41:09.327 INFO  [Agent:Local] ${leaking}`,
      `2026-08-25T07:41:24+00:00 box servicebay[1]: 2026-08-25 07:41:24.701 INFO  [Agent:Local] ${syncLine({ [QUADLET_PATH]: { content: '<3765 chars redacted>' } })}`,
    ].join('\n');
    const s = summarizeJournal(journal);
    expect(s.unitBodiesVerbatim).toBe(1);
    expect(s.contentFieldsRedacted).toBe(1);
    expect(s.leakWindow).toEqual({ first: '2026-08-25 07:41:09.327', last: '2026-08-25 07:41:09.327' });
  });

  it('has no leak window when nothing leaked', () => {
    const journal = entry(app('Agent:Local', syncLine({ [QUADLET_PATH]: { content: '<10 chars redacted>' } })));
    expect(summarizeJournal(journal).leakWindow).toBeNull();
  });

  it('survives a message truncated by journal rotation', () => {
    const journal = entry(app('Agent:Local', '{"event":"SYNC_PARTIAL","payload":{"files":{"/a":{"cont'));
    expect(() => summarizeJournal(journal)).not.toThrow();
    expect(summarizeJournal(journal).structuredMessages).toBe(0);
  });
});

describe('parseArgs', () => {
  it('defaults to the servicebay unit and a 10k-line window', () => {
    expect(parseArgs([])).toEqual({ unit: 'servicebay', lines: 10000, since: undefined });
  });
  it('takes --since so box-verify can scope the probe to the current run', () => {
    expect(parseArgs(['--unit', 'other', '--lines', '500', '--since', '1750000000'])).toEqual({
      unit: 'other', lines: 500, since: 1750000000,
    });
  });
});
