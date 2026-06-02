import { listLldapUsers, type LldapListUsersResult } from '@/lib/lldap/client';
import { sendTransactionalEmail } from '@/lib/email';
import { logger } from '@/lib/logger';

/**
 * Duplicate-email guard for the public access-request endpoint (#1510).
 *
 * When someone submits a request with an email that already has an LLDAP
 * account, the old flow still queued an admin approval that could only ever
 * fail ("Could not approve — already exists"). This guard catches the
 * duplicate at submit time:
 *
 *   - On a match: notify the *existing account owner* ("someone requested an
 *     account using your email address") and tell the caller to short-circuit
 *     — no admin-approval request is queued, no admin notification is sent.
 *   - The route returns the SAME neutral response either way, so the requester
 *     can't tell whether the email already exists (no account enumeration).
 *
 * Fail-open: if LLDAP is unreachable / not configured / errors, we can't size
 * the directory, so we let the request proceed normally rather than block a
 * legitimate submission on an LLDAP hiccup — same best-effort stance the user-
 * cap guard (`rejectIfCapped`) takes. The downside of a false-negative is only
 * that the admin sees one doomed approval (the old behaviour), which is
 * strictly better than dropping a real request.
 */

export interface ExistingEmailDeps {
  listUsers: () => Promise<LldapListUsersResult>;
  notifyOwner: (to: string, subject: string, message: string) => Promise<void>;
}

const defaultDeps: ExistingEmailDeps = {
  listUsers: listLldapUsers,
  notifyOwner: sendTransactionalEmail,
};

const OWNER_NOTICE_SUBJECT = 'Someone requested access using your email address';

function ownerNoticeBody(email: string): string {
  return (
    `Hi,\n\n` +
    `Someone just requested a new account on this home server using your email ` +
    `address (${email}). Because this address already has an account, no new ` +
    `account was created and the request was not sent to the admin.\n\n` +
    `If this was you — for example you forgot you already have an account — you ` +
    `can sign in as usual, or use the "Forgot password" link to regain access.\n\n` +
    `If it wasn't you, you can safely ignore this email; nothing has changed.`
  );
}

/**
 * Returns whether the public POST handler should short-circuit (the email
 * already belongs to an LLDAP account). When it should, the owner has already
 * been notified (best-effort) by the time this resolves.
 */
export async function handleExistingEmail(
  email: string,
  deps: ExistingEmailDeps = defaultDeps,
): Promise<{ shortCircuit: boolean }> {
  const listed = await deps.listUsers();
  if (!listed.ok) {
    // Fail-open: can't confirm, let the request proceed as before.
    logger.warn('access-requests', `Could not check LLDAP for existing email (${listed.reason}); proceeding without dedupe.`);
    return { shortCircuit: false };
  }

  const target = email.trim().toLowerCase();
  const match = listed.users.find(u => (u.email ?? '').trim().toLowerCase() === target);
  if (!match) {
    return { shortCircuit: false };
  }

  // Notify the rightful owner at THEIR stored address (not the submitted one —
  // identical here, but use the directory value as the source of truth).
  const ownerEmail = (match.email ?? email).trim();
  try {
    await deps.notifyOwner(ownerEmail, OWNER_NOTICE_SUBJECT, ownerNoticeBody(ownerEmail));
  } catch (e) {
    // sendTransactionalEmail already swallows SMTP errors, but guard anyway so
    // a notification failure never turns into a 500 (or worse, enumeration via
    // a differing error response).
    logger.warn('access-requests', `Owner-notice email failed for an existing-email request: ${e instanceof Error ? e.message : String(e)}`);
  }
  logger.info('access-requests', 'Request for an already-registered email — notified owner, skipped admin queue.');
  return { shortCircuit: true };
}
