import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { issueHandover } from '@/lib/stackInstall/credentialsHandover';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of the forced credential hand-over (#2560): hand out the file.
 *
 * POST returns the complete CSV inline together with a one-shot token.
 * Nothing is deleted here — this route only *offers*. The caller must come
 * back to `./confirm` with the token and the SHA-256 of the bytes it
 * actually saved before any password leaves this box's config.
 *
 * POST rather than GET because it mints server state (the ticket) and
 * because the body is the credential list itself — it must never end up in
 * a browser cache, a history entry, or a prefetch.
 */
export const POST = withApiHandler({}, async () => {
  const offer = await issueHandover();
  if (!offer) return NextResponse.json({ pending: 0 });
  return NextResponse.json({
    pending: offer.count,
    token: offer.token,
    filename: offer.filename,
    csv: offer.csv,
  });
});
