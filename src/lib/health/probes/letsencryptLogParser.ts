/**
 * Pure parser for the tail of NPM's `letsencrypt.log` — extracts
 * recent ACME failures (Domain / Type / Detail blocks, or the legacy
 * inline "Failed authorization procedure" format) plus a rate-limit
 * flag and the newest timestamp anywhere in the tail.
 *
 * Hoisted out of the diagnose-side probe in Phase 3b (#484) so the
 * health-check runner can call it without creating a circular import
 * (the diagnose probe is now a reader that imports the runner's
 * prefix constants). Stays a separate file from `runner.ts` because
 * the existing `certRequestFailure.test.ts` exercises this parser
 * directly — keeping the export surface stable avoids churning the
 * test.
 */

export interface ParsedFailure {
  domain: string;
  type: string;
  detail: string;
}

export interface ParsedFailureBlock {
  failures: ParsedFailure[];
  rateLimited: boolean;
  /** Newest timestamp anywhere in the tail (epoch ms, UTC-interpreted). */
  ts?: number;
}

const STRUCTURED_FAILURE_RE = /Domain:\s*(\S+)\s*\n\s*Type:\s*(\S+)\s*\n\s*Detail:\s*([^\n]+)/g;
// Legacy/inline format used by older certbot releases.
const INLINE_FAILURE_RE = /Failed authorization procedure\.\s+(\S+)\s+\(([^)]+)\):\s+urn:ietf:params:acme:error:\S+\s*::\s*([^\n]+)/g;
const RATE_LIMIT_RE = /urn:ietf:params:acme:error:rateLimited/i;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/gm;

export function parseLetsencryptTail(tail: string): ParsedFailureBlock {
  // Scope to the slice starting at the most recent "Some challenges
  // have failed" line so older failure blocks higher up don't leak in.
  // Failures in certbot output come AFTER the marker line, so we
  // start at the beginning of that line. Fall back to the full tail
  // when the marker isn't present — older log lines sometimes just
  // have "Challenge failed for domain X" without it.
  const lastMarker = tail.lastIndexOf('Some challenges have failed');
  const sliceStart = lastMarker >= 0
    ? Math.max(0, tail.lastIndexOf('\n', lastMarker) + 1)
    : 0;
  const slice = tail.slice(sliceStart);

  const failures: ParsedFailure[] = [];
  STRUCTURED_FAILURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCTURED_FAILURE_RE.exec(slice)) !== null) {
    failures.push({ domain: m[1].trim(), type: m[2].trim(), detail: m[3].trim() });
  }
  if (failures.length === 0) {
    INLINE_FAILURE_RE.lastIndex = 0;
    while ((m = INLINE_FAILURE_RE.exec(slice)) !== null) {
      failures.push({ domain: m[1].trim(), type: m[2].trim(), detail: m[3].trim() });
    }
  }

  const rateLimited = RATE_LIMIT_RE.test(slice);

  let ts: number | undefined;
  TIMESTAMP_RE.lastIndex = 0;
  const tsMatches = slice.match(TIMESTAMP_RE);
  if (tsMatches && tsMatches.length > 0) {
    const last = tsMatches[tsMatches.length - 1];
    const parsed = Date.parse(`${last.replace(' ', 'T')}Z`);
    if (Number.isFinite(parsed)) ts = parsed;
  }

  return { failures, rateLimited, ts };
}
