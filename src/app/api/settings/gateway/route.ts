import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { FritzBoxClient } from '@/lib/fritzbox/client';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Settings → Gateway (FritzBox) — read + update endpoint (#333,
 * migrated to withApiHandler in #603).
 *
 * Existing response shape preserved so `GatewaySection.tsx` doesn't
 * need to change.
 */

/** Read-only view: omit the password (we never echo it back). */
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const gw = config.gateway;
  return NextResponse.json({
    configured: !!gw,
    type: gw?.type ?? null,
    host: gw?.host ?? '',
    username: gw?.username ?? '',
    hasPassword: !!gw?.password,
    ssl: !!gw?.ssl,
  });
});

const UpdateBody = z.object({
  host: z.string().min(1).max(255),
  username: z.string().max(255).optional(),
  /** Empty / undefined means "keep the existing password unchanged". */
  password: z.string().max(255).optional(),
  ssl: z.boolean().optional(),
  /** When true, validate credentials against the FritzBox before saving. */
  test: z.boolean().optional(),
});

export const POST = withApiHandler({ body: UpdateBody }, async ({ body }) => {
  const current = await getConfig();
  const existing = current.gateway;

  // Only overwrite password when the body provided one. The form sends
  // an empty string when the operator didn't touch the field — keep
  // what's there in that case.
  const password = body.password && body.password.length > 0
    ? body.password
    : existing?.password;

  const next = {
    type: 'fritzbox' as const,
    host: body.host.trim(),
    username: body.username?.trim() || undefined,
    password,
    ssl: body.ssl ?? existing?.ssl,
  };

  if (body.test) {
    // Best-effort credential check — getStatus hits both the
    // unauthenticated UPnP path and, with credentials, authenticated
    // TR-064. Surface failures before persisting so the operator
    // doesn't silently lock themselves out.
    try {
      const client = new FritzBoxClient({
        host: next.host,
        username: next.username,
        password: next.password,
      });
      await client.getStatus();
    } catch (e) {
      return NextResponse.json({
        error: 'connection_failed',
        message: e instanceof Error ? e.message : String(e),
      }, { status: 400 });
    }
  }

  await updateConfig({ gateway: next });
  return NextResponse.json({ ok: true });
});
