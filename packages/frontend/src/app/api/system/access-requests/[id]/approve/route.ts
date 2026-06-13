import { NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/lib/config';
import { createLldapUser, getLldapUserDeepLink } from '@/lib/lldap/client';
import { sendTransactionalEmail } from '@/lib/email';
import { composeWelcomeEmail, getWelcomeEmailUrls } from '@/lib/email/welcome';
import { logger } from '@/lib/logger';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * One-click approval for an access request (#406).
 *
 * Flow:
 *   1. Look up the pending request by id.
 *   2. Provision the user in LLDAP via GraphQL using the username +
 *      profile data captured by #405. No password is set — the user
 *      enrolls via LLDAP's "Forgot password" flow on first login.
 *   3. Mark the request resolved.
 *   4. Return the LLDAP user detail URL so the UI can open the group
 *      assignment page in a new tab — that's the only manual step
 *      that remains for the admin.
 *
 * Fallback: if the request was submitted before #405 and has no
 * username, the route refuses (412) and the UI keeps the legacy
 * manual workflow. The route never partially commits — if LLDAP
 * rejects the create, the request stays pending so the admin can
 * fix the conflict (e.g. picking a different username) and retry.
 */

type Params = { id: string };

export const POST = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const config = await getConfig();
    const requests = [...(config.accessRequests ?? [])];
    const idx = requests.findIndex(r => r.id === params.id);
    if (idx < 0) {
      return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
    }
    const req = requests[idx];
    if (req.status !== 'pending') {
      return NextResponse.json({ error: 'Request is not pending.' }, { status: 409 });
    }
    if (!req.username) {
      return NextResponse.json(
        {
          error: 'This request has no username — it was submitted before the profile fields were added. Create the LLDAP user manually and click "Mark resolved".',
          reason: 'missing_username',
        },
        { status: 412 },
      );
    }

    const created = await createLldapUser({
      id: req.username,
      email: req.email,
      displayName: req.firstName && req.lastName ? `${req.firstName} ${req.lastName}` : req.name,
      firstName: req.firstName,
      lastName: req.lastName,
    });

    if (!created.ok) {
      logger.warn('access-requests:approve', `LLDAP create failed for ${req.username}: ${created.message}`);
      return NextResponse.json(
        { error: created.message, reason: created.reason },
        { status: created.reason === 'username_taken' ? 409 : 502 },
      );
    }

    requests[idx] = {
      ...req,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
    };
    await saveConfig({ ...config, accessRequests: requests });
    logger.info('access-requests:approve', `Provisioned LLDAP user ${req.username} for ${req.email}`);

    // Best-effort welcome email to the requester. No-ops cleanly when
    // email isn't configured — we still return success because the
    // LLDAP user *is* created and the admin can hand-deliver the URL.
    // Same composer the "Resend welcome email" button uses (#418).
    const urls = await getWelcomeEmailUrls();
    const welcome = composeWelcomeEmail({
      greetingName: req.firstName ?? req.name,
      username: req.username,
      portalUrl: urls.portalUrl,
      authUrl: urls.authUrl,
    });
    void sendTransactionalEmail(req.email, welcome.subject, welcome.body);

    const deepLink = await getLldapUserDeepLink(req.username);
    return NextResponse.json({ ok: true, lldapUrl: deepLink });
  },
);
