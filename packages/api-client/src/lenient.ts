// Per-row list parsing (#2784).
//
// A list getter that validates its whole response with
// `z.array(RowSchema)` is all-or-nothing: one row the backend emitted
// before a field existed (or after a partial migration) fails the array,
// `rawApi`/`callApi` throw a `TypedFetchError`, and the caller — which
// usually has a `.catch(() => null)` or an empty-state render — shows an
// EMPTY list rather than an error. That is the "empty-but-ok" failure
// class: the operator sees "there is nothing here", not "this is broken".
// It is exactly what emptied the Health tab in batch 10's box-verify.
//
// The fix is per-ROW validation: parse each element on its own, keep the
// ones that pass, drop the ones that don't, and say so in the log once
// per response. A body that is not an array at all still throws — that is
// a real route break, not a partially-migrated row.
//
// Deliberately NOT logged: the row itself. List rows carry credentials,
// tokens and manifests (`settings.ts`' `CredentialViewSchema`,
// `TokenViewSchema`, the fritzbox password on a health check), so the log
// line carries only the count and the *location* of the first failure —
// its field path and zod issue code, never a received value.

import { z, type ZodType } from 'zod';
import { logger } from '@/lib/logger-client';

export interface LenientListContext {
  /** Route (or `route#field`) the rows came from — the log context. */
  endpoint: string;
}

/** Field path + zod issue code of the first failure — no received values. */
function firstIssueLocation(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown';
  const path = issue.path.length > 0 ? issue.path.join('.') : '(row)';
  return `${path} [${issue.code}]`;
}

/**
 * Validate every element of `raw` against `schema`, keeping the rows that
 * pass. Dropped rows are counted and `logger.warn`'d once for the whole
 * response. Throws `TypeError` when `raw` is not an array.
 */
export function parseListLenient<T>(
  schema: ZodType<T>,
  raw: unknown,
  { endpoint }: LenientListContext,
): T[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`${endpoint}: expected an array, got ${raw === null ? 'null' : typeof raw}`);
  }

  const kept: T[] = [];
  let dropped = 0;
  let firstFailure: string | undefined;

  for (const row of raw) {
    const parsed = schema.safeParse(row);
    if (parsed.success) {
      kept.push(parsed.data);
      continue;
    }
    dropped += 1;
    firstFailure ??= firstIssueLocation(parsed.error);
  }

  if (dropped > 0) {
    logger.warn(
      'api-client',
      `${endpoint}: dropped ${dropped}/${raw.length} malformed row(s); first failure at ${firstFailure}`,
    );
  }

  return kept;
}

/**
 * `parseListLenient` as a zod schema, so a list getter keeps handing
 * `rawApi`/`callApi` a single schema and a nested array field
 * (`{ stacks: [...] }`, `{ nodes, edges }`) stays declarative.
 *
 * The outer `z.array(z.unknown())` is what still rejects a non-array body,
 * so `TypedFetchError` semantics are unchanged for a broken route.
 */
export function lenientArray<T>(schema: ZodType<T>, endpoint: string): ZodType<T[]> {
  return z.array(z.unknown()).transform(rows => parseListLenient(schema, rows, { endpoint }));
}
