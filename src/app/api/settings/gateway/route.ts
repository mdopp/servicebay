import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { FritzBoxClient } from '@/lib/fritzbox/client';

export const dynamic = 'force-dynamic';

/**
 * Settings → Gateway (FritzBox) — read + update endpoint (#333).
 *
 * Until this PR the only ways to change `config.gateway` were
 * re-running install-fedora-coreos.sh or hand-editing config.json on
 * the box. The "Edit Gateway" button on the Internet-Gateway card
 * also wrongly linked to /registry?selected=gateway (templates).
 */

/** Read-only view: omit the password (we never echo it back). */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
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
  } catch (e) {
    return apiError(e, { tag: 'api:settings:gateway:get', status: 500 });
  }
}

const UpdateBody = z.object({
  host: z.string().min(1).max(255),
  username: z.string().max(255).optional(),
  /** Empty / undefined means "keep the existing password unchanged". */
  password: z.string().max(255).optional(),
  ssl: z.boolean().optional(),
  /** When true, validate credentials against the FritzBox before saving. */
  test: z.boolean().optional(),
});

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = UpdateBody.parse(await request.json());
    const current = await getConfig();
    const existing = current.gateway;

    // Only overwrite password when the body provided one. The form
    // sends an empty string when the operator didn't touch the field —
    // keep what's there in that case.
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
      // unauthenticated UPnP path (anonymous IP/uptime) and, if
      // username+password are provided, switches to authenticated
      // TR-064. A failure here means either wrong creds, wrong
      // host, or unreachable box; surface it before persisting so
      // the operator doesn't silently lock themselves out.
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
  } catch (e) {
    return apiError(e, { tag: 'api:settings:gateway:post', status: 400 });
  }
}
