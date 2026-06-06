/**
 * Typed client for Hermes' native session API (maintenance chat, #1754 /
 * epic #1704). Ports the proven `solilos_chat/hermes.py` pattern from
 * mdopp/solbay.
 *
 * Contract (the native session API, NOT the gatekeeper `/converse`):
 *   - `POST /api/sessions`              -> create a session, returns `{id}`
 *   - `GET  /api/sessions`              -> `{data:[{id,...}]}` (list)
 *   - `GET  /api/sessions/{id}`         -> `{session:{...}}` (summary)
 *   - `POST /api/sessions/{id}/chat`    -> body `{input}`, returns the reply
 *
 * Connection: `http://127.0.0.1:${HERMES_API_PORT}` (loopback only — the
 * Hermes API binds 127.0.0.1; other host pods reach it over loopback,
 * remote callers go through NPM + Authelia) with `Authorization: Bearer
 * ${HERMES_API_KEY}`.
 *
 * SECURITY: the bearer key (`HERMES_API_KEY`) is held server-side only —
 * it lives in `config.installedSecrets` (encrypted at rest), is read here
 * in the backend, and is NEVER logged or returned to the browser. The
 * frontend reaches this via the loopback `/api/system/hermes/chat` route,
 * which holds the key server-side.
 */
import { getConfig, updateConfig, type AppConfig } from '@/lib/config';
import { loadSavedSecrets } from '@/lib/install/savedSecrets';
import { logger } from '@/lib/logger';

/** Raised when Hermes is unreachable or returns a non-2xx response. */
export class HermesError extends Error {
  /** HTTP status when the failure was a Hermes non-2xx; undefined on a
   *  transport error (Hermes not running / loopback refused). */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HermesError';
    this.status = status;
  }
}

/** Resolved Hermes connection settings (loopback + bearer key). */
export interface HermesConnection {
  /** e.g. `http://127.0.0.1:8642` */
  baseUrl: string;
  /** API_SERVER_KEY bearer token; empty string when not installed. */
  apiKey: string;
}

/** Template-variable name holding the Hermes HTTP API host port. */
const HERMES_API_PORT_VAR = 'HERMES_API_PORT';
/** Template-variable name holding the Hermes API bearer key (secret). */
const HERMES_API_KEY_VAR = 'HERMES_API_KEY';
/** Default Hermes API port (matches the hermes template variable default). */
const DEFAULT_HERMES_API_PORT = 8642;

/**
 * The "ServiceBay administrator for families" persona, attached as the
 * `system_prompt` overlay when the maintenance session is born. Hermes
 * accepts `system_prompt` ONLY at session create (PATCH rejects it), so
 * the persona is bound once, at birth, and is stable for the session's life.
 *
 * Tone/behaviour contract (mixed DE/EN as the family operator speaks):
 *  - family-focused; speaks to a non-expert operator running a home server
 *  - gathers knowledge from the tools/sources available rather than relying
 *    on its own assumptions
 *  - persistent ("beharrlich") — sees a task through
 *  - clear, numbered step-by-step plans a non-expert can follow
 *  - NEVER destroys data without explicit confirmation, and always ensures a
 *    backup/restore path exists first
 *  - kind and patient ("geduldig")
 *  - guiding maxim: just be helpful, make things better, never worse.
 */
export const MAINTENANCE_PERSONA_PROMPT = [
  'You are the ServiceBay administrator for families — the helpful expert',
  'who looks after a home server for a non-technical household.',
  '',
  'Who you help: the family operator. Treat them as a capable beginner, not',
  'an engineer. Avoid jargon; when a technical term is unavoidable, explain',
  'it in one plain sentence.',
  '',
  'How you work:',
  '- Gather what you need from the tools and information sources available to',
  '  you rather than relying on your own assumptions or guessing. If you do',
  "  not know something, find out — don't invent it.",
  '- Be persistent (beharrlich): see a task through to a real, verified',
  '  outcome instead of stopping at the first obstacle.',
  '- Give clear, numbered, step-by-step plans the operator can follow without',
  '  prior expertise. One action per step.',
  '- Be kind and patient (geduldig). The operator may be stressed because',
  '  something at home is not working — reassure, then guide.',
  '',
  'Safety — this is absolute:',
  '- NEVER destroy, delete, overwrite, or reset data without the explicit',
  '  confirmation of the operator.',
  '- Before any destructive or risky step, first ensure a working backup and',
  '  a restore path exist, and tell the operator what they are.',
  '- When in doubt, choose the reversible option and ask.',
  '',
  'Your guiding maxim: just be helpful, make things better, never worse.',
].join('\n');

/**
 * Resolve the Hermes loopback connection from config. The port comes from
 * the installed hermes template variable (or the default 8642); the bearer
 * key comes from `installedSecrets` (HERMES_API_KEY), decrypted by getConfig.
 *
 * The key may be absent (Hermes not installed / pre-secret config) — the
 * caller treats an empty key as "unreachable" and surfaces a 503.
 */
export function resolveHermesConnection(config: AppConfig): HermesConnection {
  const secrets = loadSavedSecrets(config);
  const apiKey = secrets[HERMES_API_KEY_VAR] ?? '';

  // The port is a non-secret variable; honour an operator override stored in
  // templateSettings, else fall back to the template default. We never log it.
  const portRaw = config.templateSettings?.[HERMES_API_PORT_VAR];
  const parsed = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HERMES_API_PORT;

  return { baseUrl: `http://127.0.0.1:${port}`, apiKey };
}

/** Reply-envelope shapes Hermes may return — kept tolerant like the Python client. */
interface ChatReplyEnvelope {
  message?: { content?: unknown };
  output?: unknown;
  reply?: unknown;
  response?: unknown;
  text?: unknown;
}

function extractReply(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as ChatReplyEnvelope;
  const msg = b.message;
  if (msg && typeof msg === 'object' && 'content' in msg && msg.content) {
    return String(msg.content);
  }
  return String(b.output ?? b.reply ?? b.response ?? b.text ?? '');
}

function extractSessionId(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const session =
    b.session && typeof b.session === 'object' ? (b.session as Record<string, unknown>) : b;
  return String(session.id ?? session.session_id ?? '');
}

/**
 * Thin typed Hermes API client. One instance per request is fine — each
 * method opens a single `fetch`. The bearer key is captured at construction
 * and never logged.
 */
export class HermesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(conn: HermesConnection, timeoutMs = 120_000) {
    this.baseUrl = conn.baseUrl.replace(/\/+$/, '');
    this.apiKey = conn.apiKey;
    this.timeoutMs = timeoutMs;
  }

  /** True once Hermes is reachable enough to attempt a call (key present). */
  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** POST/GET helper. Throws `HermesError` on transport failure or non-2xx. */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // Transport failure (Hermes not running, loopback refused, timeout).
      // Do NOT include the key/headers in the log.
      logger.warn('hermes', `request ${method} ${path} failed to reach Hermes`, {
        error: e instanceof Error ? e.message : String(e),
      });
      throw new HermesError('Hermes is unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 400) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      logger.warn('hermes', `request ${method} ${path} returned ${resp.status}`, { detail });
      throw new HermesError(`Hermes returned ${resp.status}`, resp.status);
    }
    return resp.json().catch(() => ({}));
  }

  /**
   * Create a session bound to `userId`, optionally with a `system_prompt`
   * overlay. Hermes accepts `system_prompt` only at create. Returns the id.
   */
  async createSession(userId: string, systemPrompt?: string): Promise<string> {
    const payload: Record<string, unknown> = { user_id: userId };
    if (systemPrompt) payload.system_prompt = systemPrompt;
    const body = await this.request('POST', '/api/sessions', payload);
    const id = extractSessionId(body);
    if (!id) throw new HermesError('createSession: no session id in response');
    return id;
  }

  /** Fetch a session summary, or `null` if Hermes 404s the id. */
  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    try {
      const body = await this.request('GET', `/api/sessions/${sessionId}`);
      if (!body || typeof body !== 'object') return null;
      const b = body as Record<string, unknown>;
      const session = b.session && typeof b.session === 'object' ? b.session : b;
      return session as Record<string, unknown>;
    } catch (e) {
      if (e instanceof HermesError && e.status === 404) return null;
      throw e;
    }
  }

  /** List sessions (Hermes returns them under `data`/`sessions`/`items`). */
  async listSessions(): Promise<Array<Record<string, unknown>>> {
    const body = await this.request('GET', '/api/sessions');
    if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      for (const key of ['sessions', 'items', 'data', 'results']) {
        const v = b[key];
        if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  /** Send one turn to an existing session; return the reply text. */
  async chat(sessionId: string, input: string): Promise<string> {
    const body = await this.request('POST', `/api/sessions/${sessionId}/chat`, { input });
    return extractReply(body);
  }
}

/**
 * Ensure the single designated maintenance session exists and return its id.
 *
 * The session is created once, with the admin-for-families persona overlay,
 * and its id is persisted in `config.hermes.maintenanceSessionId` so it's
 * stable across calls (and process restarts). If a persisted id no longer
 * resolves on Hermes (e.g. data was wiped), a fresh session is created and
 * re-persisted.
 */
export async function getOrCreateMaintenanceSession(
  client: HermesClient,
  userId: string,
): Promise<string> {
  const config = await getConfig();
  const existing = config.hermes?.maintenanceSessionId;
  if (existing) {
    // Confirm it still exists on Hermes; a 404 means we must recreate.
    const session = await client.getSession(existing);
    if (session) return existing;
  }
  const id = await client.createSession(userId, MAINTENANCE_PERSONA_PROMPT);
  await updateConfig({ hermes: { ...(config.hermes ?? {}), maintenanceSessionId: id } });
  return id;
}
