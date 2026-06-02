import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';
import { npmAdminCredStatus, rekeyNpmAdmin } from '@/lib/reverseProxy/npmAdminRekey';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().min(1).max(64).optional() });

/**
 * NPM admin credentials (#1530 — derive, don't ask).
 *
 * There is no free-text email/password store any more: ServiceBay's NPM
 * admin credential is owned end-to-end by the verified re-key path
 * (`rekeyNpmAdmin`, which refuses to persist anything it can't prove
 * against NPM's `/api/tokens`). This route is read + re-key only, so the
 * Reverse Proxy section and the Security "Saved credentials" row can
 * never diverge into two emails.
 *
 * GET    → DB-derived admin identity + live auth status.
 * POST   → run the verified re-key (no raw save).
 * DELETE → forget the stored credential.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    const node = query.node ?? 'Local';
    const config = await getConfig();
    const npm = config.reverseProxy?.npm;
    // Live check of the stored credential against NPM itself:
    //  ok        — stored creds authenticate (verified, in sync)
    //  rejected  — NPM 401s them (stale / diverged → re-key)
    //  no-creds  — NPM is up but nothing stored (→ re-key)
    //  unknown   — NPM not deployed/reachable (can't tell)
    const status = await npmAdminCredStatus(node);
    return NextResponse.json({
      configured: Boolean(npm?.email && npm?.password),
      email: npm?.email ?? '',
      status,
    });
  },
);

const PostBody = z.object({ node: z.string().min(1).max(64).optional() });

/**
 * Re-key NPM's admin to a fresh generated password in place (every proxy
 * route preserved), verify it against `/api/tokens`, and persist it. This
 * is the ONLY path that writes `reverseProxy.npm`. No operator-typed
 * email/password — the identity is read back from NPM's own DB.
 */
export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  const result = await rekeyNpmAdmin(body.node ?? 'Local');
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
});

export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  const next = { ...config.reverseProxy };
  delete next.npm;
  await updateConfig({ reverseProxy: next });
  return NextResponse.json({ ok: true });
});
