import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getConfig } from '@/lib/config';
import {
  HermesClient,
  HermesError,
  getOrCreateMaintenanceSession,
  resolveHermesConnection,
} from '@/lib/hermes/client';

/**
 * Turn a thrown {@link HermesError} into the right 503 message. A `401`
 * means Hermes is reachable but rejected the bearer key — ServiceBay's
 * stored key has drifted from the externally-deployed engine's
 * `API_SERVER_KEY` (#1761). That is a DISTINCT, actionable failure from a
 * genuine outage, so it gets a distinct message pointing at the reconcile
 * heal-action, never the "Is the Hermes service running?" line used for a
 * real connection failure. Both stay 503 (the assistant is unavailable to
 * the caller either way) and never leak the key.
 */
function hermesUnavailableMessage(e: HermesError): string {
  if (e.status === 401) {
    return 'Hermes authentication failed — the stored API key does not match the running engine. Open Settings → Self-Diagnose and run "Reconcile Hermes API key".';
  }
  return 'Hermes is unavailable. Is the Hermes service running?';
}

/**
 * Maintenance-chat seam (#1754, epic #1704) — the native chat panel (#1755,
 * part B) POSTs operator turns here.
 *
 * Auth: POST is a mutating verb, so `withApiHandler` runs the requireSession
 * gate — only an authenticated ServiceBay operator reaches the handler. The
 * authenticated principal (`auth.user`) is mapped to the Hermes uid.
 *
 * SECURITY: the Hermes bearer key (`HERMES_API_KEY`) is read server-side from
 * config (encrypted at rest) inside the backend client and is NEVER returned
 * to the browser. Hermes is reached over loopback (127.0.0.1) only. When
 * Hermes is unreachable (not installed / not running) we return 503 with a
 * clear, non-leaking message.
 */

const bodySchema = z.object({
  input: z.string().min(1, 'input is required'),
});

/**
 * Load the maintenance session's persisted conversation so the panel can
 * restore it on mount (#1760). Same server-side seam as POST — the Hermes key
 * never leaves the backend. GET is non-mutating so it skips the requireSession
 * gate; `/api/system/*` is gated by the proxy. Returns `{ messages }` on 200,
 * a graceful 503 when Hermes is not configured / unreachable.
 */
export const GET = withApiHandler({}, async ({ auth }) => {
  const userId = auth?.user ?? 'servicebay-operator';

  const config = await getConfig();
  const conn = resolveHermesConnection(config);
  const client = new HermesClient(conn);

  if (!client.configured) {
    return apiError(new Error('Hermes is not configured on this server'), {
      status: 503,
      tag: 'hermes',
      exposeMessage: true,
    });
  }

  try {
    const sessionId = await getOrCreateMaintenanceSession(client, userId);
    const messages = await client.getMessages(sessionId);
    return NextResponse.json({ messages });
  } catch (e) {
    if (e instanceof HermesError) {
      return apiError(new Error(hermesUnavailableMessage(e)), {
        status: 503,
        tag: 'hermes',
        exposeMessage: true,
      });
    }
    return apiError(e, { tag: 'hermes' });
  }
});

export const POST = withApiHandler({ body: bodySchema }, async ({ body, auth }) => {
  // The session gate guarantees `auth` is set on this mutating route.
  const userId = auth?.user ?? 'servicebay-operator';

  const config = await getConfig();
  const conn = resolveHermesConnection(config);
  const client = new HermesClient(conn);

  if (!client.configured) {
    return apiError(new Error('Hermes is not configured on this server'), {
      status: 503,
      tag: 'hermes',
      exposeMessage: true,
    });
  }

  try {
    const sessionId = await getOrCreateMaintenanceSession(client, userId);
    const reply = await client.chat(sessionId, body.input);
    return NextResponse.json({ reply });
  } catch (e) {
    if (e instanceof HermesError) {
      // Hermes unreachable or returned an error — surface as 503 so the
      // panel can show "the assistant is unavailable" without leaking the
      // key or internal detail. A 401 (key drift) gets a DISTINCT message
      // pointing at the reconcile heal-action (#1761), not the generic
      // "is it running?" line.
      return apiError(new Error(hermesUnavailableMessage(e)), {
        status: 503,
        tag: 'hermes',
        exposeMessage: true,
      });
    }
    return apiError(e, { tag: 'hermes' });
  }
});
