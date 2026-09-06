// Disk-import engine — local-LLM classifier client (issue #1695, retargeted #2852).
//
// A THIN client to the on-box model server's OPENAI-COMPATIBLE chat-completions
// endpoint (`POST http://host.containers.internal:11435/v1/chat/completions`,
// served by the `llama` template's llama-server). It is used SPARINGLY and only
// on the residue that the deterministic rules in classify.ts can't resolve —
// never on every file. It SUGGESTS a label; it never writes anything. The caller
// (suggest.ts) routes every suggestion into the review plan for human confirmation.
//
// ADDRESSING — `host.containers.internal`, never `127.0.0.1`/`localhost`. The
// disk-import worker runs in an ISOLATED pod netns: its launcher
// (packages/backend/src/lib/diskImport/launcher.ts) runs `podman run … -p 8080`
// with no `--network host`, so loopback inside the container is the container's
// own, not the host's. Per ADR 0007 Decision 1/3 an isolated consumer reaches a
// host-bound sibling through `host.containers.internal:<port>`. (The predecessor
// of this module spoke Ollama's `/api/generate` on `http://localhost:11434` —
// an address that never resolved from in here, which the graceful-degradation
// path below quietly absorbed as "no suggestion".)
//
// GRACEFUL DEGRADATION is the contract: if the model server is unreachable
// (connection refused), slow (timeout), or returns non-conforming output (not
// strict JSON, or a label outside the allowed set), every entry point here
// returns `null` ("no suggestion"). NOTHING in this module ever throws into the
// import flow. That also covers the interim in which llama-server still binds
// loopback only and the pod-facing listener is still owed (solarisbay#1344):
// the classifier stays silent, the deterministic engine is unaffected.

/**
 * Default chat-completions endpoint of the on-box model server, addressed the
 * way ADR 0007 requires from an isolated pod. Override with `LLM_ENDPOINT`.
 */
const DEFAULT_ENDPOINT = 'http://host.containers.internal:11435/v1/chat/completions';

/**
 * The household model alias llama-server answers under (it echoes the alias back
 * in the response's `model` field). Override with `LLM_MODEL`.
 */
const DEFAULT_MODEL = 'gemma-4-e4b';

/** Env var that overrides {@link DEFAULT_ENDPOINT}. */
const ENDPOINT_ENV = 'LLM_ENDPOINT';
/** Env var that overrides {@link DEFAULT_MODEL}. */
const MODEL_ENV = 'LLM_MODEL';

// MIGRATION NOTE (#2852): the retired Ollama client hard-coded its endpoint and
// read no environment at all, so no `OLLAMA_*` variable was ever honoured here
// and none is honoured now — the neutral `LLM_ENDPOINT` / `LLM_MODEL` above are
// the only overrides. An operator pointing the classifier at a different model
// server sets those (a full URL including the `/v1/chat/completions` path).

/** Hard cap on how long we wait for the model server before giving up. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Cap the model's reply so a runaway generation can't hang the parse. */
const MAX_RESPONSE_CHARS = 4_000;

export interface LlmClientOptions {
  /** Override the chat-completions endpoint (tests / non-default host). */
  endpoint?: string;
  /** Override the model alias. */
  model?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable environment (tests). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * One completion request: a prompt and the closed set of labels the model is
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
 * The OpenAI chat-completions envelope. `choices[0].message.content` holds the
 * model's text, which (because we asked for `response_format: json_object`) is
 * itself a JSON document we then parse + validate. `model` echoes the alias the
 * server actually has loaded — informational only; we never branch on it.
 */
interface ChatCompletionResponse {
  model?: unknown;
  choices?: unknown;
}

/**
 * Ask the model server for a single strict-JSON label. Returns the validated
 * suggestion, or `null` for ANY failure (unreachable, timeout, malformed/
 * over-long body, missing/non-string message content, or a label outside
 * `req.allowed`). Never throws.
 */
export async function requestLabel(
  req: LabelRequest,
  opts: LlmClientOptions = {},
): Promise<LabelSuggestion | null> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    env = process.env,
  } = opts;
  const endpoint = opts.endpoint ?? envOverride(env, ENDPOINT_ENV) ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? envOverride(env, MODEL_ENV) ?? DEFAULT_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `response_format: json_object` constrains the server to emit valid JSON;
      // `stream: false` gives us one complete envelope, not an SSE token stream.
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildPrompt(req) }],
        response_format: { type: 'json_object' },
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    let envelope: ChatCompletionResponse;
    try {
      envelope = (await res.json()) as ChatCompletionResponse;
    } catch {
      return null;
    }

    return parseSuggestion(messageContent(envelope), req.allowed);
  } catch {
    // Connection refused, DNS failure, AbortError (timeout) — all "no suggestion".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A non-empty env value, or `undefined` so the next fallback wins. */
function envOverride(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Dig `choices[0].message.content` out of the envelope without trusting any of
 * it. Anything not shaped like the OpenAI response yields `undefined`, which
 * parseSuggestion turns into "no suggestion".
 */
function messageContent(envelope: ChatCompletionResponse): unknown {
  const { choices } = envelope;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const message: unknown = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return undefined;
  return (message as Record<string, unknown>).content;
}

/**
 * Wrap the caller's prompt with the strict-output contract. Even with
 * `response_format: json_object` set, we restate the schema in-band so a small
 * model is more likely to emit the exact shape — and we validate regardless.
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
 * Parse + validate the model's message content into a LabelSuggestion. Rejects
 * (→ `null`): non-string / over-long content, non-JSON, non-object JSON, a
 * missing/empty label, or a label outside the allowed set. The `reason` is
 * optional and coerced to a trimmed string (empty if absent).
 */
function parseSuggestion(
  content: unknown,
  allowed: readonly string[],
): LabelSuggestion | null {
  if (typeof content !== 'string') return null;
  if (content.length === 0 || content.length > MAX_RESPONSE_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
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
