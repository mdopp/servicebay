/**
 * Minimal letsdebug.net client. Submits an HTTP-01 reachability test
 * for a single domain and polls until completion (or our timeout).
 *
 * letsdebug is a Go service; its JSON responses use PascalCase keys
 * by default (`ID`, `Status`, `Result`). Reading lowercase
 * (`data.id`) silently returned `undefined` and triggered a misleading
 * "submission missing id" error. The parser below normalises both
 * casings so a future API tweak in either direction stays handled.
 *
 * Used by:
 *   - `domain_external_reachability` diagnose probe (continuous via
 *     diagnose runs, cached for 24 h to be polite to letsdebug).
 *   - On-demand external checks from the UI (planned).
 */

export interface LetsdebugProblem {
  name?: string;
  explanation?: string;
  severity?: string;
}

export interface LetsdebugResult {
  problems: LetsdebugProblem[];
  submissionUrl: string;
}

const BASE = 'https://letsdebug.net';
const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2000;
const SUBMIT_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 10_000;
// letsdebug's WAF can serve a Cloudflare challenge to generic fetch
// calls. Setting a recognisable User-Agent (and Accept) drops the
// challenge rate in practice. We also identify ourselves clearly so
// letsdebug's operator can correlate traffic if it ever becomes a
// problem.
const HEADERS_BASE: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'servicebay/diagnose (https://github.com/mdopp/servicebay)',
};

/** Read either `key` or its case-shifted variant — handles
 *  `ID`/`id`, `Status`/`status`, etc. without committing to one. */
function pick<T = unknown>(obj: Record<string, unknown> | null | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

async function submit(domain: string): Promise<number> {
  const res = await fetch(`${BASE}/`, {
    method: 'POST',
    headers: { ...HEADERS_BASE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, method: 'http-01' }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`letsdebug submission HTTP ${res.status}`);
  }
  // Read as text first so we can include a snippet of the body in the
  // error message — without it, parser failures showed up as "missing
  // id" with no way to tell what letsdebug actually returned (HTML
  // Cloudflare challenge? rate-limit JSON?).
  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`letsdebug submission returned non-JSON (first 120 chars): ${raw.slice(0, 120)}`);
  }
  const id = pick<number>(data, 'id', 'ID', 'Id');
  if (typeof id !== 'number') {
    throw new Error(`letsdebug submission missing id (got keys: ${Object.keys(data).join(', ') || 'none'})`);
  }
  return id;
}

interface NormalisedPoll {
  status: string;
  problems: LetsdebugProblem[];
  // True iff the response had a non-null `result`/`Result` field.
  // letsdebug occasionally returns `{status:'Complete', result:null}`
  // when the backend short-circuits a test (rate-limit, server error
  // mid-probe). Without distinguishing this from a legitimate
  // empty-problems result, an unrun test silently looks "all green".
  hasResult: boolean;
}

function normalisePoll(raw: Record<string, unknown>): NormalisedPoll {
  const status = pick<string>(raw, 'status', 'Status') ?? '';
  const hasResult =
    ('result' in raw && raw.result !== null && raw.result !== undefined) ||
    ('Result' in raw && raw.Result !== null && raw.Result !== undefined);
  const result = pick<Record<string, unknown>>(raw, 'result', 'Result');
  const problems = (pick<LetsdebugProblem[]>(result, 'problems', 'Problems') ?? []).map(p => {
    const o = p as unknown as Record<string, unknown>;
    return {
      name: pick<string>(o, 'name', 'Name'),
      explanation: pick<string>(o, 'explanation', 'Explanation'),
      severity: pick<string>(o, 'severity', 'Severity'),
    };
  });
  return { status, problems, hasResult };
}

async function poll(domain: string, id: number): Promise<NormalisedPoll> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const res = await fetch(`${BASE}/${encodeURIComponent(domain)}/${id}`, {
      headers: HEADERS_BASE,
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`letsdebug poll HTTP ${res.status}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const data = normalisePoll(raw);
    if (data.status === 'Complete') {
      // Guard against the `Complete + result:null` shape — letsdebug
      // returns this when it didn't actually run a probe (rate limit,
      // backend error). Surface as a transport-style error so the
      // runner records `status:'fail'` instead of "no problems".
      if (!data.hasResult) {
        throw new Error('letsdebug returned status=Complete with no result payload (test was not actually run — likely rate-limit or backend error)');
      }
      return data;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`letsdebug timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}

export async function runLetsdebugForDomain(domain: string): Promise<LetsdebugResult> {
  const id = await submit(domain);
  const result = await poll(domain, id);
  return {
    problems: result.problems,
    submissionUrl: `${BASE}/${encodeURIComponent(domain)}/${id}`,
  };
}
