import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { getConfig, saveConfig, type AccessRequest } from '@/lib/config';
import { sendEmailAlert } from '@/lib/email';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * "Request access" endpoint for the family portal (#242 follow-up).
 *
 *   POST — public (proxy.ts allows POST without a session). Anonymous
 *          family-LAN visitor submits name + email + optional message.
 *          Persisted in config.accessRequests; admin gets an email
 *          notification when notifications.email is configured.
 *
 *   GET  — admin-only. Returns all requests so Settings can render
 *          the table.
 *
 * Per-request operations (PATCH/DELETE by id) live in [id]/route.ts.
 *
 * Rate-limit: hard cap of 50 pending requests. New POSTs once the
 * cap is hit return 429. Admin can clear resolved entries to make
 * room. Cap is per-process; not perfect but enough to prevent a
 * hostile LAN device from filling config.json.
 */

const MAX_PENDING = 50;
const POST_BODY_LIMIT = 4_096;

const PostBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  message: z.string().trim().max(1_000).optional(),
});

export async function POST(request: Request) {
  // Cap raw body size so a hostile client can't push gigabytes.
  // Next.js doesn't enforce this by default for route handlers.
  const text = await request.text();
  if (text.length > POST_BODY_LIMIT) {
    return NextResponse.json({ error: 'Request body too large.' }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  let parsed;
  try {
    parsed = PostBody.parse(body);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid body.' }, { status: 400 });
  }

  const config = await getConfig();
  const existing = config.accessRequests ?? [];
  const pending = existing.filter(r => r.status === 'pending');
  if (pending.length >= MAX_PENDING) {
    return NextResponse.json(
      { error: 'Too many pending requests right now. The family admin needs to review the existing ones first.' },
      { status: 429 },
    );
  }

  const newRequest: AccessRequest = {
    id: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    name: parsed.name,
    email: parsed.email,
    message: parsed.message,
    status: 'pending',
  };
  await saveConfig({ ...config, accessRequests: [...existing, newRequest] });
  logger.info('access-requests', `New request from ${parsed.email}`);

  // Best-effort email notification — sendEmailAlert no-ops when
  // email isn't configured.
  void sendEmailAlert(
    'New access request',
    `${parsed.name} (${parsed.email}) has requested access to your home server.\n\n` +
    (parsed.message ? `Message: ${parsed.message}\n\n` : '') +
    'Open Settings → Access Requests to create the LLDAP user.',
  );

  return NextResponse.json({ ok: true, id: newRequest.id });
}

export async function GET() {
  const config = await getConfig();
  const requests = config.accessRequests ?? [];
  return NextResponse.json({ requests });
}
