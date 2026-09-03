/**
 * #2784 — the shared per-row list parser.
 *
 * The bug class this closes: a list getter validating its whole response
 * with `z.array(RowSchema)` throws on ONE malformed row, and the caller's
 * `.catch(() => null)` / empty-state render turns that into "there is
 * nothing here" instead of "this is broken".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';

import { parseListLenient, lenientArray } from './lenient';
import { logger } from '@/lib/logger-client';

const RowSchema = z.object({ id: z.string(), n: z.number() });

afterEach(() => vi.restoreAllMocks());

describe('parseListLenient', () => {
  it('returns [] for an empty array without warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(parseListLenient(RowSchema, [], { endpoint: 'GET /x' })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps every row when they all parse, and does not warn', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
    expect(parseListLenient(RowSchema, rows, { endpoint: 'GET /x' })).toEqual(rows);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops every row when none parse — [] , not a throw', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(parseListLenient(RowSchema, [{ nope: 1 }, 'x'], { endpoint: 'GET /x' })).toEqual([]);
  });

  it('keeps the good rows and drops the bad one (the whole point)', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const kept = parseListLenient(
      RowSchema,
      [{ id: 'a', n: 1 }, { id: 'bad' }, { id: 'c', n: 3 }],
      { endpoint: 'GET /x' },
    );
    expect(kept.map(r => r.id)).toEqual(['a', 'c']);
  });

  it('warns once per response with the endpoint, the dropped count and the first issue path', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    parseListLenient(RowSchema, [{ id: 'a', n: 1 }, { id: 'bad' }, { n: 2 }], {
      endpoint: 'GET /api/health/checks',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('GET /api/health/checks');
    expect(line).toContain('2/3');
    expect(line).toContain('n [');
  });

  it('never logs the row contents — list rows carry secrets', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    parseListLenient(RowSchema, [{ id: 'a', n: 'sb_supersecret_token' }], { endpoint: 'GET /x' });
    const line = warn.mock.calls[0].join(' ');
    expect(line).not.toContain('sb_supersecret_token');
  });

  it('throws when the payload is not an array at all — that is a real route break', () => {
    expect(() => parseListLenient(RowSchema, { error: 'nope' }, { endpoint: 'GET /x' })).toThrow(TypeError);
    expect(() => parseListLenient(RowSchema, null, { endpoint: 'GET /x' })).toThrow(TypeError);
  });
});

describe('lenientArray (the schema form)', () => {
  it('parses per row inside a wrapper object', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const Wrapper = z.object({ rows: lenientArray(RowSchema, 'GET /x#rows') });
    expect(Wrapper.parse({ rows: [{ id: 'a', n: 1 }, { bad: true }] })).toEqual({
      rows: [{ id: 'a', n: 1 }],
    });
  });

  it('fails validation when the field is not an array', () => {
    const Wrapper = z.object({ rows: lenientArray(RowSchema, 'GET /x#rows') });
    expect(Wrapper.safeParse({ rows: 'nope' }).success).toBe(false);
  });

  it('composes with .catch([]) for the fields that had it before', () => {
    const Wrapper = z.object({ rows: lenientArray(RowSchema, 'GET /x#rows').catch([]) });
    expect(Wrapper.parse({ rows: 'nope' })).toEqual({ rows: [] });
  });
});
