/**
 * GET + PUT /api/system/update-window (#603 — migrated to withApiHandler).
 *
 * Owns the unified auto-update window — see config.ts:updateWindow for
 * the full state-machine reasoning. The TL;DR is that ServiceBay can
 * reach three different "restart now" buttons (Zincati for OS reboots,
 * `podman-auto-update.timer` for container image refresh, and its own
 * app-updater); this route renders the operator's window choice onto
 * the host so all three fire only inside the same quiet slot.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { getExecutor } from '@/lib/executor';
import { applyUpdateWindow } from '@/lib/updateWindow';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const DaySchema = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const WindowSchema = z.object({
  enabled: z.boolean(),
  days: z.array(DaySchema).min(1),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'startTime must be HH:MM (UTC)'),
  lengthMinutes: z.number().int().min(30).max(1440),
  applyTo: z.object({
    os: z.boolean().optional(),
    containers: z.boolean().optional(),
    servicebay: z.boolean().optional(),
  }).optional(),
});

export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  return NextResponse.json({ window: config.updateWindow ?? null });
});

export const PUT = withApiHandler({ body: WindowSchema }, async ({ body }) => {
  // Dedupe days + apply defaults to the optional applyTo flags.
  const dedupedDays = body.days.filter((d, i, arr) => arr.indexOf(d) === i);
  const window = {
    enabled: body.enabled,
    days: dedupedDays,
    startTime: body.startTime,
    lengthMinutes: body.lengthMinutes,
    applyTo: {
      os: body.applyTo?.os ?? true,
      containers: body.applyTo?.containers ?? true,
      servicebay: body.applyTo?.servicebay ?? false,
    },
  };

  await applyUpdateWindow(getExecutor(), window);
  await updateConfig({ updateWindow: window });

  return NextResponse.json({ window });
});
