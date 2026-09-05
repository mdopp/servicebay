import { describe, it, expect } from 'vitest';
import { reassembleMessages, summarizeJournal, parseArgs } from './check-journal-redaction';
import { redactStructuredLogLine } from '../packages/backend/src/lib/agent/handler';

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

describe('the emitter\'s own output, end to end (#2676)', () => {
  // #2676 cut the state-sync journal payload down to a summary. The probe
  // reads those very lines, so the two have to be checked together: a cut
  // made at the *sink* (a size cap on the rendered line) would leave half a
  // JSON object here, `classify` would bail on the parse, and the probe would
  // report a clean journal it never actually inspected.

  /** What `handler.ts` now writes for a files+containers state sync. */
  function emittedSyncLine(): string {
    return redactStructuredLogLine(
      JSON.stringify({
        event: 'SYNC_PARTIAL',
        payload: {
          files: { [QUADLET_PATH]: { path: QUADLET_PATH, content: QUADLET_BODY } },
          containers: Array.from({ length: 24 }, (_, i) => ({
            id: `${i}`,
            names: [`svc${i}-app`],
            labels: { 'org.opencontainers.image.title': `App ${i}`, 'org.opencontainers.image.url': 'https://example.invalid' },
            mounts: [{ Source: '/var/mnt/data', Destination: '/data' }],
          })),
        },
      }),
    ) as string;
  }

  it('still parses as a structured message the probe can judge', () => {
    const s = summarizeJournal(entry(app('Agent:Local', emittedSyncLine())));
    expect(s.structuredMessages).toBe(1);
    expect(s.contentFieldsRedacted).toBe(1);
    expect(s.contentFieldsVerbatim).toBe(0);
    expect(s.unitBodiesVerbatim).toBe(0);
  });

  it('fits in one journal entry, so conmon no longer chunks a state sync', () => {
    // 8192 bytes is where conmon splits a line; a summarised sync is a couple
    // of hundred, so the reassembly path is no longer exercised by every sync.
    expect(emittedSyncLine().length).toBeLessThan(8192);
    expect(reassembleMessages(entry(app('Agent:Local', emittedSyncLine())))[0].chunks).toBe(1);
  });

  it('would still turn red if the redaction regressed under the summary', () => {
    // The probe must be able to fail on the new shape, not merely pass on it.
    const leaking = JSON.stringify({
      event: 'SYNC_PARTIAL',
      payload: {
        files: { [QUADLET_PATH]: { content: QUADLET_BODY } },
        containers: { count: 24, items: ['svc0-app'] },
      },
    });
    const s = summarizeJournal(entry(app('Agent:Local', leaking)));
    expect(s.unitBodiesVerbatim).toBe(1);
    expect(s.findings[0].keyPath).toBe(`payload.files.${QUADLET_PATH}.content`);
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

/**
 * #2833 — the bare `Environment=NAME=VALUE` shape, which the structured
 * `content` scan above is blind to by construction: the quadlet body reaches
 * the journal as a shell ARGUMENT inside a log sentence, so there is no
 * `content` key anywhere to walk to. The operator's measurement was exactly
 * that asymmetry — 10 leaking lines, 0 verbatim `content` fields.
 */
describe('summarizeJournal — bare Environment= assignments (#2833)', () => {
  const leakingLine = `Command failed: sh -c 'q' sh '[Container]\\nEnvironment=SERVICEBAY_PASSWORD=PLACEHOLDER-NOT-A-REAL-SECRET\\nEnvironment=NODE_ENV=production'`;

  it('flags a secret assignment in a plain prose line — no structured payload needed', () => {
    const s = summarizeJournal(entry(app('Server', leakingLine)));
    expect(s.envAssignmentsVerbatim).toBe(1);
    expect(s.structuredMessages).toBe(0); // the #2603 scan sees nothing here
    expect(s.unitBodiesVerbatim).toBe(0);
    expect(s.findings[0].kind).toBe('environment');
    expect(s.findings[0].keyPath).toBe('Environment=SERVICEBAY_PASSWORD');
  });

  it('reports the NAME and the LENGTH, never the value', () => {
    const printed = JSON.stringify(summarizeJournal(entry(app('Server', leakingLine))));
    expect(printed).not.toContain('PLACEHOLDER-NOT-A-REAL-SECRET');
    expect(printed).toContain('Environment=SERVICEBAY_PASSWORD');
    expect(summarizeJournal(entry(app('Server', leakingLine))).findings[0].length).toBe(
      'PLACEHOLDER-NOT-A-REAL-SECRET'.length,
    );
  });

  it('a value never runs past the escaped line break into the next directive', () => {
    // `Environment=NODE_ENV=production` follows a literal `\n`; if the value
    // swallowed it the reported length would be far larger than the secret.
    expect(summarizeJournal(entry(app('Server', leakingLine))).findings[0].length).toBeLessThan(40);
  });

  it('passes the marker lib/log-format.ts writes', () => {
    const clean = `Command failed: sh -c 'q' sh '[Container]\\nEnvironment=SERVICEBAY_PASSWORD=<29 chars redacted>'`;
    const s = summarizeJournal(entry(app('Server', clean)));
    expect(s.envAssignmentsVerbatim).toBe(0);
    expect(s.envAssignmentsRedacted).toBe(1);
    expect(s.findings).toEqual([]);
  });

  it('passes that same marker after get_logs has masked it on the way out', () => {
    // `redactLogText` rewrites `PASSWORD=<29` (it stops at the space) to
    // `PASSWORD=<redacted>`, leaving the tail of the marker standing. That tail
    // is what keeps a masked value distinguishable from a real one here.
    const throughReadTool = `Environment=SERVICEBAY_PASSWORD=<redacted> chars redacted>`;
    const s = summarizeJournal(entry(app('Server', throughReadTool)));
    expect(s.envAssignmentsVerbatim).toBe(0);
    expect(s.envAssignmentsRedacted).toBe(1);
  });

  it('FLAGS a bare <redacted>: the read tool only masks what was really there', () => {
    const s = summarizeJournal(entry(app('Server', 'Environment=SERVICEBAY_PASSWORD=<redacted>')));
    expect(s.envAssignmentsVerbatim).toBe(1);
  });

  it('ignores a non-secret name and an unset value', () => {
    const s = summarizeJournal(
      [
        entry(app('Server', 'Environment=NODE_ENV=production')),
        entry(app('Server', 'Environment=SERVICEBAY_PASSWORD=')),
      ].join('\n'),
    );
    expect(s.envAssignmentsVerbatim).toBe(0);
    expect(s.envAssignmentsRedacted).toBe(0);
    expect(s.findings).toEqual([]);
  });

  it('catches ...TOKEN= and ...KEY= too, not only ...PASSWORD=', () => {
    const s = summarizeJournal(
      [
        entry(app('Agent:Local', 'Environment=SB_TOKEN=PLACEHOLDER-NOT-A-REAL-SECRET')),
        entry(app('Agent:Local', 'Environment=RESTIC_KEY=PLACEHOLDER-NOT-A-REAL-SECRET')),
        entry(app('Agent:Local', 'Environment=CLIENT_SECRET=PLACEHOLDER-NOT-A-REAL-SECRET')),
      ].join('\n'),
    );
    expect(s.envAssignmentsVerbatim).toBe(3);
  });

  it('finds it inside the agent JSON-escaped command payload — the measured shape', () => {
    const quadlet = '[Container]\nEnvironment=SERVICEBAY_PASSWORD=PLACEHOLDER-NOT-A-REAL-SECRET\nImage=x';
    const payload = JSON.stringify({ command: `sh -c 'q' sh '${quadlet}'` });
    const s = summarizeJournal(entry(app('Agent:Local', `Received command: exec (ID: x, Payload: ${payload})`)));
    expect(s.envAssignmentsVerbatim).toBe(1);
  });
});
