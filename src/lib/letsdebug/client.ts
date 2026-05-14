/**
 * Minimal letsdebug.net client. Submits an HTTP-01 reachability test
 * for a single domain and polls until completion (or our timeout).
 *
 * Used by:
 *   - `domain_external_reachability` diagnose probe (continuous via
 *     diagnose runs, cached for 24 h to be polite to letsdebug).
 *   - On-demand external checks from the UI (planned).
 *
 * Both consumers share the same submit+poll loop so the caching
 * semantics stay consistent — letsdebug rate-limits, and we don't
 * want two layers of caching to drift.
 */

export interface LetsdebugProblem {
  name?: string;
  explanation?: string;
  severity?: string;
}

interface SubmissionResponse {
  id?: number;
}

interface PollResponse {
  id?: number;
  status?: 'Queued' | 'Processing' | 'Complete';
  result?: {
    problems?: LetsdebugProblem[];
  };
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

async function submit(domain: string): Promise<number> {
  const res = await fetch(`${BASE}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ domain, method: 'http-01' }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`letsdebug submission HTTP ${res.status}`);
  }
  const data = (await res.json()) as SubmissionResponse;
  if (typeof data.id !== 'number') {
    throw new Error('letsdebug submission missing id');
  }
  return data.id;
}

async function poll(domain: string, id: number): Promise<PollResponse> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const res = await fetch(`${BASE}/${encodeURIComponent(domain)}/${id}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`letsdebug poll HTTP ${res.status}`);
    }
    const data = (await res.json()) as PollResponse;
    if (data.status === 'Complete') return data;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`letsdebug timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}

export async function runLetsdebugForDomain(domain: string): Promise<LetsdebugResult> {
  const id = await submit(domain);
  const result = await poll(domain, id);
  return {
    problems: result.result?.problems ?? [],
    submissionUrl: `${BASE}/${encodeURIComponent(domain)}/${id}`,
  };
}
