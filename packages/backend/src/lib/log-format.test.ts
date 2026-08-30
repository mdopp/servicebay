/**
 * The console sink writes to a journal, not to a terminal (#2667).
 *
 * These pin the three pure decisions. The *real* emission — a process whose
 * stdout is a pipe — is asserted in `tests/backend/logger_journal_shape.test.ts`;
 * that one is the guard, this one says why each byte is what it is.
 */

import { describe, it, expect } from 'vitest';
import { renderLogArg, shouldColorize, toSingleJournalLine } from './log-format';

describe('shouldColorize — colour is a TTY feature (#2667)', () => {
  it('is false for a pipe: journald never renders the escapes', () => {
    expect(shouldColorize({}, {})).toBe(false);
    expect(shouldColorize({ isTTY: false }, {})).toBe(false);
  });

  it('is true for an interactive terminal — colours are not traded away', () => {
    expect(shouldColorize({ isTTY: true }, {})).toBe(true);
  });

  it('honours NO_COLOR, and NO_COLOR beats a real TTY', () => {
    expect(shouldColorize({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    // no-color.org: set and non-empty, *whatever* the value.
    expect(shouldColorize({ isTTY: true }, { NO_COLOR: '0' })).toBe(false);
    expect(shouldColorize({ isTTY: true }, { NO_COLOR: 'anything' })).toBe(false);
  });

  it('an empty NO_COLOR is not set — the TTY still decides', () => {
    expect(shouldColorize({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(shouldColorize({ isTTY: false }, { NO_COLOR: '' })).toBe(false);
  });

  it('FORCE_COLOR reaches the coloured path from a pipe, but never beats NO_COLOR', () => {
    expect(shouldColorize({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldColorize({ isTTY: false }, { FORCE_COLOR: '0' })).toBe(false);
    expect(shouldColorize({ isTTY: false }, { FORCE_COLOR: '' })).toBe(false);
    expect(shouldColorize({ isTTY: false }, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false);
  });
});

describe('toSingleJournalLine — one log call, one journal entry (#2667)', () => {
  it('drops trailing newlines: they were 47.7% of the box journal, all blank', () => {
    expect(toSingleJournalLine('payload\n')).toBe('payload');
    expect(toSingleJournalLine('payload\n\n\n')).toBe('payload');
    expect(toSingleJournalLine('payload   \n')).toBe('payload');
  });

  it('keeps an embedded break visible as the literal two chars \\n, never a real one', () => {
    const out = toSingleJournalLine('a\nb');
    expect(out).toBe('a\\nb');
    expect(out).not.toContain('\n');
  });

  it('collapses a run of blank interior lines instead of emitting empty entries', () => {
    expect(toSingleJournalLine('a\n\n\nb')).toBe('a\\nb');
    expect(toSingleJournalLine('a\n   \n\t\nb')).toBe('a\\nb');
  });

  it('normalises CRLF and a lone CR — conmon relays both', () => {
    expect(toSingleJournalLine('a\r\nb')).toBe('a\\nb');
    expect(toSingleJournalLine('a\rb')).toBe('a\\nb');
  });

  it('never returns a string containing a real newline, for any input', () => {
    for (const input of ['', '\n', '\r\n\r\n', 'a', 'a\nb\nc\n', '{"k":"v"}\n\n']) {
      expect(toSingleJournalLine(input)).not.toMatch(/[\r\n]/);
    }
  });

  it('leaves a single-line payload byte-identical — no truncation at this sink', () => {
    const big = `{"content":"${'x'.repeat(50_000)}"}`;
    expect(toSingleJournalLine(big)).toBe(big);
  });
});

describe('renderLogArg — args are stringified here, not inspected by console (#2667)', () => {
  it('renders an object on one line (Node would inspect it across many)', () => {
    const out = renderLogArg({ Config: { Labels: { 'org.opencontainers.image.title': 'jellyfin' } } });
    expect(out).toBe('{"Config":{"Labels":{"org.opencontainers.image.title":"jellyfin"}}}');
    expect(out).not.toMatch(/[\r\n]/);
  });

  it('keeps an Error stack — the flattening is what makes it one entry, not dropping it', () => {
    const err = new Error('boom');
    const out = renderLogArg(err);
    expect(out).toContain('boom');
    expect(out).toContain('log-format.test');
    expect(toSingleJournalLine(out)).not.toMatch(/[\r\n]/);
  });

  it('falls back to name: message for an Error with no stack', () => {
    const err = new Error('stackless');
    err.stack = '';
    expect(renderLogArg(err)).toBe('Error: stackless');
  });

  it('survives a circular payload instead of throwing inside the logger', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(renderLogArg(a)).toContain('[Circular]');
  });

  it('renders primitives, functions and undefined without an inspect call', () => {
    expect(renderLogArg('already a string')).toBe('already a string');
    expect(renderLogArg(null)).toBe('null');
    expect(renderLogArg(undefined)).toBe('undefined');
    expect(renderLogArg(42)).toBe('42');
    expect(renderLogArg(true)).toBe('true');
    expect(renderLogArg(BigInt(10))).toBe('10n');
    expect(renderLogArg(function namedFn() {})).toBe('[Function namedFn]');
  });

  it('does not truncate a large blob — the size cap belongs at #2603 redaction', () => {
    const content = 'y'.repeat(20_000);
    expect(renderLogArg({ content })).toBe(JSON.stringify({ content }));
  });
});
