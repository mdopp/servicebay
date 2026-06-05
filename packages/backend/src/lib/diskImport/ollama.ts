// Disk-import engine — local-Ollama classifier client (issue #1695).
//
// A THIN client to the on-box Ollama (`http://localhost:11434/api/generate`).
// It is used SPARINGLY and only on the residue that the deterministic rules in
// classify.ts can't resolve — never on every file. It SUGGESTS a label; it
// never writes anything. The caller (suggest.ts) routes every suggestion into
// the review plan for human confirmation.
//
// GRACEFUL DEGRADATION is the contract: if Ollama is unreachable (connection
// refused), slow (timeout), or returns non-conforming output (not strict JSON,
// or a label outside the allowed set), every entry point here returns `null`
// ("no suggestion"). NOTHING in this module ever throws into the import flow.

/** Default Ollama generate endpoint on the single-node box. */
const DEFAULT_ENDPOINT = 'http://localhost:11434/api/generate';

/** A small, fast local model — classification is a cheap labelling task. */
const DEFAULT_MODEL = 'llama3.2:1b';

/** Hard cap on how long we wait for Ollama before giving up (no suggestion). */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Cap the model's reply so a runaway generation can't hang the parse. */
const MAX_RESPONSE_CHARS = 4_000;

export interface OllamaClientOptions {
  /** Override the generate endpoint (tests / non-default host). */
  endpoint?: string;
  /** Override the model tag. */
  model?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * One generation request: a prompt and the closed set of labels the model is
 * allowed to answer with. The reply MUST be JSON of the shape
 * `{ "label": <one of labels>, "reason": <short string> }` — anything else is
 * rejected (→ `null`).
 */
export interface LabelRequest {
  /** The compact, self-contained prompt describing the item to label. */
  prompt: string;
  /** The closed set of acceptable labels. A reply outside this set is rejected. */
  allowed: readonly string[];
}

/** A validated suggestion: a label from the request's `allowed` set + reasoning. */
export interface LabelSuggestion {
  label: string;
  /** The model's short, human-readable justification (for the review plan). */
  reason: string;
}

/**
 * The Ollama HTTP envelope for a `format: json` generate call. `response` holds
 * the model's text, which (because we asked for `format: json`) is itself a
 * JSON document we then parse + validate.
 */
interface OllamaGenerateResponse {
  response?: unknown;
}

/**
 * Ask Ollama for a single strict-JSON label. Returns the validated suggestion,
 * or `null` for ANY failure (unreachable, timeout, malformed/over-long body,
 * non-JSON `response`, or a label outside `req.allowed`). Never throws.
 */
export async function requestLabel(
  req: LabelRequest,
  opts: OllamaClientOptions = {},
): Promise<LabelSuggestion | null> {
  const {
    endpoint = DEFAULT_ENDPOINT,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `format: json` constrains Ollama to emit valid JSON; `stream: false`
      // gives us one complete envelope instead of a token stream.
      body: JSON.stringify({
        model,
        prompt: buildPrompt(req),
        format: 'json',
        stream: false,
        options: { temperature: 0 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    let envelope: OllamaGenerateResponse;
    try {
      envelope = (await res.json()) as OllamaGenerateResponse;
    } catch {
      return null;
    }

    return parseSuggestion(envelope.response, req.allowed);
  } catch {
    // Connection refused, DNS failure, AbortError (timeout) — all "no suggestion".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap the caller's prompt with the strict-output contract. Even with
 * `format: json` set, we restate the schema in-band so a small model is more
 * likely to emit the exact shape — and we validate the result regardless.
 */
function buildPrompt(req: LabelRequest): string {
  const labels = req.allowed.join(', ');
  return [
    req.prompt,
    '',
    `Answer with ONLY a JSON object: {"label": "<one of: ${labels}>", "reason": "<short justification>"}.`,
    `The "label" MUST be exactly one of: ${labels}. Do not invent other labels.`,
  ].join('\n');
}

/**
 * Parse + validate the model's `response` field into a LabelSuggestion. Rejects
 * (→ `null`): non-string / over-long responses, non-JSON, non-object JSON, a
 * missing/empty label, or a label outside the allowed set. The `reason` is
 * optional and coerced to a trimmed string (empty if absent).
 */
function parseSuggestion(
  response: unknown,
  allowed: readonly string[],
): LabelSuggestion | null {
  if (typeof response !== 'string') return null;
  if (response.length === 0 || response.length > MAX_RESPONSE_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const label = typeof obj.label === 'string' ? obj.label.trim() : '';
  if (!label || !allowed.includes(label)) return null;

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  return { label, reason };
}
