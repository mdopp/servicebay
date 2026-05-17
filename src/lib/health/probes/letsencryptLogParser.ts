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

/** Coarse category of an ACME failure — derived from the detail text
 *  by `classifyFailure`. The diagnose probe surfaces this as a label
 *  ("Port 80 unreachable", "CAA blocked", …) so the operator knows
 *  which fix-path to pursue without having to read certbot prose
 *  every time. `other` is the catch-all when the detail doesn't
 *  match any known pattern — the row still shows the raw text. */
export type FailureCategory =
  | 'rate-limit'
  | 'port-80'
  | 'dns'
  | 'caa'
  | 'dnssec'
  | 'tls-sni'
  | 'other';

export interface ParsedFailure {
  domain: string;
  type: string;
  detail: string;
  category: FailureCategory;
}

export interface ParsedFailureBlock {
  failures: ParsedFailure[];
  rateLimited: boolean;
  /** Newest timestamp anywhere in the tail (epoch ms, UTC-interpreted). */
  ts?: number;
}

/** Map certbot's free-form `detail` to a coarse failure category.
 *  Patterns lifted from the ACME error taxonomy + observed messages.
 *  Order matters: more specific patterns first, generic last.
 *  Internal — tested indirectly via `parseLetsencryptTail`. */
function classifyFailure(detail: string): FailureCategory {
  const d = detail.toLowerCase();
  if (/ratelimited|too many (failed authorizations|certificates)/.test(d)) return 'rate-limit';
  if (/caa record|caa for/.test(d)) return 'caa';
  if (/dnssec|dnskey|rrsig/.test(d)) return 'dnssec';
  if (/timeout during connect|connection refused|no route to host|connection reset|fetching .+?:80/.test(d)) return 'port-80';
  if (/dns problem|nxdomain|no a record|no aaaa record|servfail/.test(d)) return 'dns';
  if (/tls-sni|tls-alpn/.test(d)) return 'tls-sni';
  return 'other';
}

/** Human label for the category, shown as a prefix on the per-row
 *  detail. Keeps the surface a single phrase so the row stays scannable. */
export function categoryLabel(c: FailureCategory): string {
  switch (c) {
    case 'rate-limit': return 'LE rate-limited';
    case 'port-80':    return 'Port 80 unreachable';
    case 'dns':        return 'DNS problem';
    case 'caa':        return 'CAA record blocks issuance';
    case 'dnssec':     return 'DNSSEC misconfiguration';
    case 'tls-sni':    return 'Legacy TLS-SNI challenge';
    case 'other':      return 'ACME error';
  }
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
    const detail = m[3].trim();
    failures.push({ domain: m[1].trim(), type: m[2].trim(), detail, category: classifyFailure(detail) });
  }
  if (failures.length === 0) {
    INLINE_FAILURE_RE.lastIndex = 0;
    while ((m = INLINE_FAILURE_RE.exec(slice)) !== null) {
      const detail = m[3].trim();
      failures.push({ domain: m[1].trim(), type: m[2].trim(), detail, category: classifyFailure(detail) });
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
