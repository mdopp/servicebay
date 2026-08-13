import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { redeemHandover } from '@/lib/stackInstall/credentialsHandover';

export const dynamic = 'force-dynamic';

/**
 * Step 2 of the forced credential hand-over (#2560): prove delivery, then
 * delete.
 *
 * The caller sends back the token it was given plus the `credentialReceipt`
 * it computed over the file it saved. Both must match what `issueHandover`
 * recorded, or **nothing is deleted** and the entries stay exactly as
 * pending as they were. That is the whole point: a blocked, truncated or
 * aborted download must cost the operator a retry, never a credential.
 *
 * A rejection is a 200 with `ok: false`, not a 4xx — "that isn't proof"
 * is a normal outcome of a normal flow, and the UI has to render it as
 * "the download didn't complete, try again", not as a crash.
 */
const ConfirmBody = z.object({
  token: z.string().min(1).max(200),
  /** `<byteLength>-<16 hex digits>`, per `credentialReceipt`. */
  receipt: z.string().regex(/^\d{1,10}-[0-9a-f]{16}$/),
});

export const POST = withApiHandler({ body: ConfirmBody }, async ({ body }) => {
  const result = await redeemHandover(body.token, body.receipt);
  return NextResponse.json(result);
});
