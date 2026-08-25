/**
 * Journal-leak probe: does a structured agent log line still carry a systemd
 * unit body verbatim? (#2616, follow-up to #2603.)
 *
 * ## Why this is a script and not a prose step in the box-verify playbook
 *
 * The manual version of this check — `journalctl --user -u servicebay -o json`
 * plus an eyeballed split on `_COMM` — reached the *wrong* verdict on
 * 2026-08-25 and nearly got a live leak filed as "podman's own behaviour, not
 * ours". Two traps, both structural, both removed here:
 *
 * 1. **`_COMM` is not an emitter discriminator on this box.** ServiceBay itself
 *    runs from its own `.container` **Quadlet** unit (Ignition writes it, see
 *    `tools/sb/internal/build/assets/fedora-coreos.bu`). Its stdout/stderr is
 *    relayed into the journal by **conmon**, so *every* line of
 *    `journalctl --user -u servicebay` carries `_COMM=conmon` — the redacted
 *    ones and the leaking ones alike. Splitting on `_COMM` therefore separates
 *    nothing; it only invents a second emitter that does not exist.
 * 2. **conmon chunks a long line at 8192 bytes**, so one 160 KB structured log
 *    message arrives as ~20 separate journal entries. Counting "entries" or
 *    grepping line-wise both mis-measure it. `reassembleMessages` puts the
 *    chunks back together before anything is judged.
 *
 * ## What it asserts
 *
 * The agent's state sync ships quadlet bytes as
 * `{event, payload: {files: {<path>: {content: …}}}}`. #2603 masks every
 * `content` string at the *sink* (`agent/v4/agent.py::_redact_for_log` and,
 * as a second line of defence for a stale agent, `agent/handler.ts::
 * redactStructuredLogLine`), so a healthy box shows `<N chars redacted>` there
 * and nothing else. This probe fails when a `content` field carries a unit body
 * verbatim instead of that marker.
 *
 * Note it keys on that **structural** signal, never on spotting a secret: the
 * read-scoped MCP `get_logs` tool already masks secret values on the way out
 * (`mcp/redact.ts`, #321), so the plaintext is not visible from here even when
 * the journal on disk does hold it. "A unit body sits where a size marker
 * belongs" is the observable that survives that masking — and it is the same
 * observable whether or not the particular unit happens to carry a secret.
 *
 * Output is shape-only by construction (paths, lengths, counts). It never
 * prints file content, so a red result is safe to paste into an issue.
 *
 * House pattern, sibling to scripts/check-invariants.ts — tsx, node: only, no
 * new dep. Box I/O goes through scripts/autoloop-box.ts (read-scoped `get_logs`,
 * never `exec_command`).
 *
 *   tsx scripts/check-journal-redaction.ts [--unit servicebay] [--lines 10000] [--since <unix-seconds>]
 *
 * Every finding carries the emitting message's timestamp, because a red result
 * has two very different meanings: entries written *before* the box picked up
 * the fix are history the journal still holds (rotate the secrets, the code is
 * fine), while entries written *after* it mean the leak is live. `--since`
 * scopes the read to the current run when only the live question matters.
 *
 * Exits 0 (clean), 1 (a unit body reached the journal verbatim), 2 (setup
 * error — no box address/token, or the box did not answer).
 */

import { mcpCall } from './autoloop-box';

/** A journal line's own prefix: `<ts> <host> <identifier>[pid]: <message>`. */
const JOURNAL_PREFIX = /^(\S+)\s+(\S+)\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/;

/** ServiceBay's own log prefix inside that message: `<date> <time> LEVEL [Source] …`. */
const APP_PREFIX = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d[.,]?\d*)\s+(\w+)\s+\[([^\]]{1,80})\]\s?/;

/** The size marker every redacted `content` field is replaced with (#2603). */
const REDACTED_CONTENT = /^<\d+ chars redacted>$/;

/** A systemd unit / quadlet body: a section header on a line of its own. */
const UNIT_SECTION = /^[ \t]*\[(Unit|Service|Install|Container|Kube|Pod|Network|Volume|Image|Build)\][ \t]*$/m;

/** Guard against a pathological payload while walking it — mirrors REDACT_MAX_DEPTH. */
const WALK_MAX_DEPTH = 40;

export interface JournalMessage {
  /** 1-based line number of the message's first chunk, for pointing a human at it. */
  line: number;
  /** ServiceBay's own timestamp for the message, or null if it carried no prefix. */
  ts: string | null;
  /** systemd syslog identifier (`servicebay`, `podman`, `systemd`, …). */
  identifier: string;
  /** ServiceBay's log source label (`Agent:Local`, `Server`, …), or null if unstructured. */
  source: string | null;
  /** How many 8192-byte journal entries conmon split this message across. */
  chunks: number;
  /** The message body with ServiceBay's own prefix stripped. */
  body: string;
}

/**
 * Undo conmon's 8192-byte chunking: a message starts at the first line whose
 * body carries ServiceBay's own log prefix, and every following line without
 * one is a continuation of it (either a conmon chunk or a genuine embedded
 * newline). Pure — the parsing, not the fetching, is what needs testing.
 */
export function reassembleMessages(journal: string): JournalMessage[] {
  const out: JournalMessage[] = [];
  let current: JournalMessage | null = null;
  const lines = journal.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const m = JOURNAL_PREFIX.exec(raw);
    const identifier: string = m ? m[3] : (current ? current.identifier : '(unknown)');
    const text = m ? m[4] : raw;
    const app = APP_PREFIX.exec(text);
    if (app) {
      if (current) out.push(current);
      current = { line: i + 1, ts: app[1], identifier, source: app[3], chunks: 1, body: text.slice(app[0].length) };
    } else if (current) {
      current.body += text;
      current.chunks++;
    } else {
      out.push({ line: i + 1, ts: null, identifier, source: null, chunks: 1, body: text });
    }
  }
  if (current) out.push(current);
  return out;
}

export interface Finding {
  line: number;
  /** When the leaking message was written — live leak vs. history the journal still holds. */
  ts: string | null;
  source: string | null;
  event: string | null;
  /** Dotted key path to the offending `content` field — a file path, never content. */
  keyPath: string;
  /** Length of the verbatim string. Its *value* is deliberately never reported. */
  length: number;
}

export interface Summary {
  messagesScanned: number;
  structuredMessages: number;
  contentFieldsRedacted: number;
  contentFieldsVerbatim: number;
  /** Verbatim `content` fields that are recognisably a systemd unit body. */
  unitBodiesVerbatim: number;
  /** Timestamps of the first and last leaking message — is this live or history? */
  leakWindow: { first: string | null; last: string | null } | null;
  findings: Finding[];
}

/**
 * Classify one reassembled message. Returns null when it isn't a structured
 * `{event, payload}` agent line — the vast majority of journal traffic.
 */
function classify(msg: JournalMessage): { event: string | null; redacted: number; verbatim: number; findings: Finding[] } | null {
  const body = msg.body.trimStart();
  if (!body.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // truncated by journal rotation, or simply not our shape
  }
  if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null;
  const eventValue = (parsed as Record<string, unknown>).event;
  const event = typeof eventValue === 'string' ? eventValue : null;

  let redacted = 0;
  let verbatim = 0;
  const findings: Finding[] = [];

  const walk = (value: unknown, path: string[], depth: number): void => {
    if (depth > WALK_MAX_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...path, `[${i}]`], depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'content' && typeof item === 'string') {
        if (REDACTED_CONTENT.test(item)) {
          redacted++;
        } else {
          verbatim++;
          if (UNIT_SECTION.test(item)) {
            findings.push({ line: msg.line, ts: msg.ts, source: msg.source, event, keyPath: [...path, key].join('.'), length: item.length });
          }
        }
        continue;
      }
      walk(item, [...path, key], depth + 1);
    }
  };
  walk((parsed as { payload: unknown }).payload, ['payload'], 0);

  return { event, redacted, verbatim, findings };
}

/** Summarise a journal capture. Pure — takes the text, returns counts + shapes. */
export function summarizeJournal(journal: string): Summary {
  const messages = reassembleMessages(journal);
  const summary: Summary = {
    messagesScanned: messages.length,
    structuredMessages: 0,
    contentFieldsRedacted: 0,
    contentFieldsVerbatim: 0,
    unitBodiesVerbatim: 0,
    leakWindow: null,
    findings: [],
  };
  for (const msg of messages) {
    const c = classify(msg);
    if (!c) continue;
    summary.structuredMessages++;
    summary.contentFieldsRedacted += c.redacted;
    summary.contentFieldsVerbatim += c.verbatim;
    summary.unitBodiesVerbatim += c.findings.length;
    summary.findings.push(...c.findings);
  }
  const stamps = summary.findings.map(f => f.ts).filter((t): t is string => t !== null);
  if (stamps.length) summary.leakWindow = { first: stamps[0], last: stamps[stamps.length - 1] };
  return summary;
}

// ---------- CLI ----------

export function parseArgs(argv: string[]): { unit: string; lines: number; since?: number } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = get('--since');
  return { unit: get('--unit') ?? 'servicebay', lines: Number(get('--lines') ?? 10000), since: since ? Number(since) : undefined };
}

async function cli(): Promise<void> {
  const { unit, lines, since } = parseArgs(process.argv.slice(2));
  let stdout: string;
  try {
    const args: Record<string, unknown> = { source: 'service', name: unit, lines };
    if (since !== undefined) args.since = since;
    const r = await mcpCall<{ stdout?: string }>('get_logs', args, 90000);
    stdout = r.stdout ?? '';
  } catch (err) {
    console.error(`could not read the ${unit} journal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const summary = summarizeJournal(stdout);
  // Cap the printed findings: the counts carry the verdict, and a red box can
  // hold hundreds of them.
  console.log(JSON.stringify({ unit, requestedLines: lines, since, ...summary, findings: summary.findings.slice(0, 20) }, null, 2));
  if (summary.unitBodiesVerbatim > 0) {
    console.error(
      `FAIL: ${summary.unitBodiesVerbatim} systemd unit bodies reached the journal verbatim where a "<N chars redacted>" marker belongs, ` +
        `between ${summary.leakWindow?.first} and ${summary.leakWindow?.last}. ` +
        `This is the #2603 leak class — the box is running an image without that sink redaction, or a new unredacted sink was added. ` +
        `Check that window against when the box last picked up an image: entries older than the fix are history, not a live leak. ` +
        `Either way the journal still holds them, and no fix undoes that — rotate them (assists/recipe-rotate-a-service-secret.md).`,
    );
    process.exit(1);
  }
  console.log(`OK: no unit body reached the journal verbatim (${summary.contentFieldsRedacted} content fields redacted).`);
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('check-journal-redaction.ts') || invoked.endsWith('check-journal-redaction.js')) {
  cli().catch(e => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  });
}
