import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { getConfig, saveConfig, getAdminBaseUrl, type AccessRequest } from '@/lib/config';
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

// LLDAP `uid` accepts a wider character set, but we constrain to
// `[a-z0-9._-]` so it round-trips cleanly through URLs, filesystem
// paths, and most app-level username validators without further
// sanitization on the admin side.
const USERNAME_RE = /^[a-z0-9._-]{1,60}$/;

const PostBody = z.object({
  // Free-text name kept for backward compatibility with portal clients
  // that haven't been updated yet. New submissions also send firstName
  // and lastName; if those are present, the server composes `name`
  // from them — see the POST handler.
  name: z.string().trim().min(1).max(120).optional(),
  email: z.email().max(200),
  message: z.string().trim().max(1_000).optional(),
  username: z.string().trim().regex(USERNAME_RE, 'Username must be lowercase letters, digits, ., _ or -, max 60 chars').optional(),
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
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

  // Compose display name from firstName/lastName when both are
  // provided (new clients); otherwise fall back to the free-text
  // `name` field (old clients). At least one source is required.
  const composed = parsed.firstName && parsed.lastName
    ? `${parsed.firstName} ${parsed.lastName}`
    : parsed.name?.trim();
  if (!composed) {
    return NextResponse.json(
      { error: 'Name is required (or firstName + lastName).' },
      { status: 400 },
    );
  }

  const newRequest: AccessRequest = {
    id: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    name: composed,
    email: parsed.email,
    message: parsed.message,
    username: parsed.username,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    status: 'pending',
  };
  await saveConfig({ ...config, accessRequests: [...existing, newRequest] });
  logger.info('access-requests', `New request from ${parsed.email}`);

  // Best-effort email notification — sendEmailAlert no-ops when
  // email isn't configured.
  const adminBase = getAdminBaseUrl(config);
  const deepLink = adminBase ? `${adminBase}/settings/integrations#access-requests` : null;
  void sendEmailAlert(
    'New access request',
    `${parsed.name} (${parsed.email}) has requested access to your home server.\n\n` +
    (parsed.message ? `Message: ${parsed.message}\n\n` : '') +
    (deepLink
      ? `Review and approve: ${deepLink}`
      : 'Open Settings → Access Requests to create the LLDAP user.'),
  );

  return NextResponse.json({ ok: true, id: newRequest.id });
}

export async function GET() {
  const config = await getConfig();
  const requests = config.accessRequests ?? [];
  return NextResponse.json({ requests });
}
