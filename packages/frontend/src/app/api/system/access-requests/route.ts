import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { getConfig, saveConfig, getAdminBaseUrl, type AccessRequest } from '@/lib/config';
import { sendEmailAlert } from '@/lib/email';
import { isOverUserLimit, DEFAULT_MAX_USERS } from '@/lib/portal/userCap';
import { handleExistingEmail } from './existingEmail';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

// NOTE: POST uses `withApiHandler({ skipAuth: true })` — the endpoint
// is public (anonymous family-LAN visitors hit it from the portal) so
// it opts out of the handler's built-in requireSession gate. GET is
// admin-only and goes through the handler normally.

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

/**
 * Rate-limit / capacity guard for the public access-request endpoint (#1426).
 * Returns a 429 response when either cap is hit, else null:
 *   - MAX_PENDING pending requests (anti-spam, config-free), or
 *   - approved LLDAP users + pending >= config.maxUsers (default 20). The
 *     LLDAP count is best-effort: if LLDAP is unreachable we can't size the
 *     user cap, so we fall back to the pending guard rather than block
 *     legitimate requests on an LLDAP hiccup.
 */
async function rejectIfCapped(maxUsers: number, pendingCount: number): Promise<NextResponse | null> {
  if (pendingCount >= MAX_PENDING) {
    return NextResponse.json(
      { error: 'Too many pending requests right now. The family admin needs to review the existing ones first.' },
      { status: 429 },
    );
  }
  if (await isOverUserLimit(maxUsers, pendingCount)) {
    return NextResponse.json(
      { error: `This home server has reached its user limit (${maxUsers}). Ask the admin to remove an inactive account or raise the limit in Settings.` },
      { status: 429 },
    );
  }
  return null;
}

export const POST = withApiHandler({ skipAuth: true }, async ({ request }) => {
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
  const capResponse = await rejectIfCapped(config.maxUsers ?? DEFAULT_MAX_USERS, pending.length);
  if (capResponse) return capResponse;

  // #1510 — if the email already has an LLDAP account, queueing an admin
  // approval is doomed (it can only fail "already exists"). Short-circuit:
  // notify the rightful owner and return the SAME neutral success below
  // (no admin queue, no enumeration). Fails open if LLDAP is unreachable.
  const { shortCircuit } = await handleExistingEmail(parsed.email);
  if (shortCircuit) {
    // Same response shape as a real submission so the requester can't tell
    // the email already exists. The id is a throwaway UUID — the status
    // endpoint will report `not-found`, identical to a cleared request.
    return NextResponse.json({ ok: true, id: crypto.randomUUID() });
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
  notifyAdminOfRequest(config, newRequest);

  return NextResponse.json({ ok: true, id: newRequest.id });
});

/**
 * Best-effort "New access request" admin notification — sendEmailAlert
 * no-ops when email isn't configured. Split out of the POST handler to
 * keep it under the size/complexity budget.
 */
function notifyAdminOfRequest(config: Awaited<ReturnType<typeof getConfig>>, req: AccessRequest): void {
  const adminBase = getAdminBaseUrl(config);
  const deepLink = adminBase ? `${adminBase}/settings/access#access-requests` : null;
  void sendEmailAlert(
    'New access request',
    `${req.name} (${req.email}) has requested access to your home server.\n\n` +
    (req.message ? `Message: ${req.message}\n\n` : '') +
    (deepLink
      ? `Review and approve: ${deepLink}`
      : 'Open Settings → Access Requests to create the LLDAP user.'),
  );
}

export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const requests = config.accessRequests ?? [];
  return NextResponse.json({ requests });
});
