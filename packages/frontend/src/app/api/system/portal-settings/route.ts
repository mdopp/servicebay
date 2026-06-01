/**
 * GET + PUT /api/system/portal-settings (#1456).
 *
 * Admin surface for the two family-portal knobs:
 *   - maxUsers     — cap on approved LLDAP users + pending requests
 *                    (enforced in access-requests POST; default 20).
 *   - portalLanOnly — serve /portal to LAN clients only (app gate).
 *
 * Both persist to config.json and survive restart (getConfig/updateConfig).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { DEFAULT_MAX_USERS } from '@/lib/portal/userCap';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  maxUsers: z.number().int().positive().max(100000),
  portalLanOnly: z.boolean(),
});

export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  return NextResponse.json({
    maxUsers: config.maxUsers ?? DEFAULT_MAX_USERS,
    portalLanOnly: config.portalLanOnly ?? false,
    defaultMaxUsers: DEFAULT_MAX_USERS,
  });
});

export const PUT = withApiHandler({ body: BodySchema }, async ({ body }) => {
  await updateConfig({ maxUsers: body.maxUsers, portalLanOnly: body.portalLanOnly });
  return NextResponse.json({ maxUsers: body.maxUsers, portalLanOnly: body.portalLanOnly });
});
