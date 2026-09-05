// @vitest-environment node
/**
 * #2836 — the DB half of the `Environment=<SECRET>=<value>` leak.
 *
 * #2833 masked secret `Environment=` assignments in `toSingleJournalLine`,
 * the *console* funnel. `Logger.insertLog` still wrote the raw message into
 * `DATA_DIR/logs.db`, where it survives the full retention window and is read
 * straight back by `queryLogs` and the in-app log viewer — so the value the
 * journal no longer showed was still sitting at rest, and rotating the
 * credential (#2621) remained the only remedy.
 *
 * These tests assert against **the stored row**, not a console spy: they log
 * the two emitter shapes #2833 identified (the relayed agent payload and
 * `CommandError`'s `Command failed: <the whole command>`) and read them back
 * through `queryLogs`. A control line with a non-secret `Environment=` name
 * must come back byte-identical, so the fix cannot be "redact everything".
 *
 * The Logger singleton binds to `process.cwd()/data/logs.db` in its
 * constructor, so `process.cwd` is stubbed at a temp dir **before** the module
 * is imported — that keeps the real `data/logs.db` out of the test and gives
 * the node-env DB path (`isServer`) a real better-sqlite3 file to write to.
 *
 * Every "secret" here is a literal placeholder (CLAUDE.md, secret hygiene).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LogFilter } from '@/lib/logger';

/** The columns this test reads back; `LogEntry` itself is module-private. */
interface StoredRow {
  message: string;
  args?: unknown[];
}

const FAKE_SECRET = 'PLACEHOLDER-NOT-A-REAL-SECRET';

let dir: string;
let logger: {
  info: (tag: string, message: string, ...args: unknown[]) => void;
  warn: (tag: string, message: string, ...args: unknown[]) => void;
  queryLogs: (filter: LogFilter) => StoredRow[];
};

/** The single row this tag wrote, straight out of logs.db. */
function storedRow(tag: string): StoredRow {
  const rows = logger.queryLogs({ tags: [tag], limit: 10 });
  expect(rows, `no row stored for ${tag}`).toHaveLength(1);
  return rows[0];
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-logdb-redaction-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  // Dynamic import: the constructor (and its logs.db open) must run with the
  // stubbed cwd already in place.
  ({ logger } = await import('@/lib/logger'));
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('logs.db never stores a secret Environment= assignment (#2836)', () => {
  it('masks the value in the stored row for the CommandError shape', () => {
    const tag = 'logdb-redaction-commanderror';
    logger.warn(
      tag,
      `Command failed: sh -c '<WRITE_QUADLET_SH>' sh '[Container]\n` +
        `Environment=X_PASSWORD=${FAKE_SECRET}\nEnvironment=NODE_ENV=production\n'`,
    );

    const row = storedRow(tag);
    expect(row.message).not.toContain(FAKE_SECRET);
    expect(row.message).toContain(`X_PASSWORD=<${FAKE_SECRET.length} chars redacted>`);
  });

  it('masks the value in the stored row for the relayed agent-payload shape', () => {
    const tag = 'logdb-redaction-agentpayload';
    // The agent flattens its payload through json.dumps first, so the body
    // arrives with escaped newlines and escaped quotes already in it.
    logger.info(
      tag,
      `Received command: exec Payload: {"command": "sh -c 'w' sh '[Container]\\n` +
        `Environment=\\"X_TOKEN=${FAKE_SECRET}\\"\\n'"}`,
    );

    const row = storedRow(tag);
    expect(row.message).not.toContain(FAKE_SECRET);
    expect(row.message).toContain(`X_TOKEN=`);
    expect(row.message).toContain(`<${FAKE_SECRET.length} chars redacted>`);
  });

  it('masks a secret nested inside an extra argument, in the row and in args', () => {
    const tag = 'logdb-redaction-args';
    logger.warn(tag, 'quadlet write failed', {
      unit: `[Container]\nEnvironment=X_PASSWORD=${FAKE_SECRET}\n`,
    });

    const row = storedRow(tag);
    expect(JSON.stringify(row.args)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(row.args)).toContain('chars redacted>');
  });

  it('leaves a non-secret Environment= line byte-identical (control)', () => {
    const tag = 'logdb-redaction-control';
    const intact = 'Command failed: sh -c \'w\' sh \'[Container]\nEnvironment=NODE_ENV=production\nEnvironment=TZ=UTC\n\'';
    logger.info(tag, intact);

    expect(storedRow(tag).message).toBe(intact);
  });

  it('does not re-count an already-masked marker when the journal line is rendered', () => {
    // The console sink runs the same redactor a second time over the entry
    // insertLog already masked; a non-idempotent pass would shrink
    // `<29 chars redacted>` to `<3 chars redacted>`.
    const tag = 'logdb-redaction-idempotent';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logger.warn(tag, `[Container]\nEnvironment=X_PASSWORD=${FAKE_SECRET}\n`);
      const marker = `X_PASSWORD=<${FAKE_SECRET.length} chars redacted>`;
      expect(storedRow(tag).message).toContain(marker);
      expect(String(spy.mock.calls.at(-1)?.[0])).toContain(marker);
    } finally {
      spy.mockRestore();
    }
  });
});
