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
      // key or internal detail.
      return apiError(new Error('Hermes is unavailable. Is the Hermes service running?'), {
        status: 503,
        tag: 'hermes',
        exposeMessage: true,
      });
    }
    return apiError(e, { tag: 'hermes' });
  }
});
