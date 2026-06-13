import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getWelcomeEmailUrls } from '@/lib/email/welcome';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Public-readable status of one access request — for the family
 * portal's pending / approved CTAs (#1001).
 *
 * The submitter persists their request id in localStorage right after
 * the POST succeeds (`sb.portal.lastAccessRequest`). On every portal
 * load, the page reads that id back, GETs this endpoint, and renders
 * either:
 *
 *   - `pending`  → "Your request is being reviewed — check your email"
 *   - `resolved` → "Welcome! Set your password" (deep-links to the
 *                  Authelia portal where the visitor clicks Forgot
 *                  password to enroll, mirroring the welcome email)
 *   - `not-found` → silent fallback to the default Request-access CTA
 *
 * Security stance: the request id is a `crypto.randomUUID()`. An
 * attacker would need to guess a 128-bit value to read someone else's
 * status, and even on a hit the response carries only first-name + status +
 * the (anyway public) Authelia URL. No email, no message body, no
 * admin metadata leaks out. The endpoint is `skipAuth: true` because
 * the visitor by definition has no session yet.
 *
 * Mirrors the on-demand pattern of `/api/auth/lldap-url` rather than
 * the admin-only PATCH/DELETE that live in the sibling `[id]/route.ts`.
 */

type Params = { id: string };

// UUIDs are 36 chars `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. A loose
// shape check guards against path-traversal probes without rejecting
// future UUID variants — the lookup below is a strict-equality match
// against `crypto.randomUUID()`-shaped strings either way.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withApiHandlerParams<undefined, undefined, Params>(
  { skipAuth: true },
  async ({ params }) => {
    if (!UUID_SHAPE.test(params.id)) {
      return NextResponse.json({ status: 'not-found' } as const);
    }
    const config = await getConfig();
    const req = (config.accessRequests ?? []).find(r => r.id === params.id);
    if (!req) {
      return NextResponse.json({ status: 'not-found' } as const);
    }
    if (req.status === 'pending') {
      return NextResponse.json({
        status: 'pending' as const,
        firstName: req.firstName ?? req.name,
        requestedAt: req.requestedAt,
      });
    }
    // A denied request provisions nothing — fall back silently to the
    // default Request-access CTA rather than the "account ready" block.
    if (req.status === 'denied') {
      return NextResponse.json({ status: 'not-found' } as const);
    }
    // `approved` (and legacy `resolved`, which always meant the approve
    // path before #1824) → the "set your password" CTA.
    const urls = await getWelcomeEmailUrls();
    return NextResponse.json({
      status: 'resolved' as const,
      firstName: req.firstName ?? req.name,
      username: req.username,
      resolvedAt: req.resolvedAt,
      authUrl: urls.authUrl,
    });
  },
);
