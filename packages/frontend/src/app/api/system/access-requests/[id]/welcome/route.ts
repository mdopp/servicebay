import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { sendTransactionalEmail } from '@/lib/email';
import { composeWelcomeEmail, getWelcomeEmailUrls } from '@/lib/email/welcome';
import { logger } from '@/lib/logger';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Re-send the welcome email for an already-approved access request
 * (#418). The first welcome mail is sent automatically by the
 * approve route (#406/#407); this endpoint is the "the family member
 * lost the email, send it again" affordance. Same composer is used
 * for both so the wording stays consistent.
 *
 * Requires the request to have a `username` (i.e. it must have gone
 * through the new profile-fields flow from #405). Legacy entries
 * without one return 412 — those didn't get an auto-welcome either.
 */

type Params = { id: string };

export const POST = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const config = await getConfig();
    const req = (config.accessRequests ?? []).find(r => r.id === params.id);
    if (!req) {
      return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
    }
    if (!req.username) {
      return NextResponse.json(
        { error: 'This request has no username on file — no welcome email was ever sent and there is nothing to resend.' },
        { status: 412 },
      );
    }
    const emailEnabled = config.notifications?.email?.enabled;
    if (!emailEnabled) {
      return NextResponse.json(
        { error: 'SMTP is not configured under Settings → Notifications.' },
        { status: 412 },
      );
    }

    const urls = await getWelcomeEmailUrls();
    const welcome = composeWelcomeEmail({
      greetingName: req.firstName ?? req.name,
      username: req.username,
      portalUrl: urls.portalUrl,
      authUrl: urls.authUrl,
    });
    await sendTransactionalEmail(req.email, welcome.subject, welcome.body);
    logger.info('access-requests:welcome', `Resent welcome email to ${req.email}`);
    return NextResponse.json({ ok: true });
  },
);
