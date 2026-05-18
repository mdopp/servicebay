import { z } from 'zod';
import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { persistSingleSecret } from '@/lib/install/savedSecrets';

export const dynamic = 'force-dynamic';

/**
 * Single-secret atomic upsert into `config.installedSecrets`. The wizard
 * (`useStackInstall.ts`) calls this every time it generates a secret /
 * RSA key / bcrypt hash, so the value is persisted before any unit is
 * deployed. If the install then fails mid-flow, the retry sees the same
 * values instead of regenerating and mismatching encrypted-at-rest data.
 * #622.
 */
const Body = z.object({
  varName: z.string().min(1),
  value: z.string().min(1),
});

export const POST = withApiHandler({ body: Body }, async ({ body }) => {
  const wrote = await persistSingleSecret(body.varName, body.value);
  return NextResponse.json({ ok: true, wrote });
});
