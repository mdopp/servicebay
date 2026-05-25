import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { sendTestEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/notifications/email/test
 * Body: { to: string }
 *
 * Sends one canned "test" email to `to` using the currently-stored SMTP
 * settings, so the operator can verify host/port/user/pass/from in
 * isolation before turning the master toggle on. Surfaces SMTP errors
 * directly (auth failures, DNS, TLS) — `sendTestEmail` throws on
 * failure unlike the alert/transactional paths that swallow into a
 * console log.
 *
 * Auth required (settings panel only); validates recipient as a
 * minimum-shape email so a typo doesn't get reported as an upstream
 * SMTP error.
 */
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const to = typeof body?.to === 'string' ? body.to.trim() : '';
    if (!to || !EMAIL_RX.test(to)) {
      return NextResponse.json({ ok: false, error: 'Recipient (`to`) must be a valid email address.' }, { status: 400 });
    }
    await sendTestEmail(to);
    return NextResponse.json({ ok: true, sentTo: to });
  } catch (error) {
    // Pull out the SMTP error message so the UI can render it verbatim
    // — "Invalid login: 535-5.7.8 Username and Password not accepted"
    // is exactly what the operator needs to see, much more useful than
    // a generic 500.
    const message = error instanceof Error ? error.message : String(error);
    return apiError(new Error(message), { tag: 'api:system:notifications:email:test', status: 502 });
  }
});
