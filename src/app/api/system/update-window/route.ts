/**
 * GET + PUT /api/system/update-window
 *
 * Owns the unified auto-update window — see config.ts:updateWindow for
 * the full state-machine reasoning. The TL;DR is that ServiceBay can
 * reach three different "restart now" buttons (Zincati for OS reboots,
 * `podman-auto-update.timer` for container image refresh, and its own
 * app-updater); this route renders the operator's window choice onto
 * the host so all three fire only inside the same quiet slot. When
 * the operator hasn't decided yet (or has opted out), the locks are
 * applied on server boot — see `applyLocks` in lib/updateWindow.ts
 * and server.ts.
 */
import { NextResponse } from 'next/server';
import { getConfig, updateConfig, type AppConfig } from '@/lib/config';
import { getExecutor } from '@/lib/executor';
import { applyUpdateWindow } from '@/lib/updateWindow';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

type Window = NonNullable<AppConfig['updateWindow']>;

const VALID_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validate(body: unknown): { ok: true; window: Window } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  const enabled = b.enabled;
  if (typeof enabled !== 'boolean') return { ok: false, error: '`enabled` must be a boolean' };

  if (!Array.isArray(b.days)) return { ok: false, error: '`days` must be an array' };
  const days = b.days as unknown[];
  if (days.length === 0) return { ok: false, error: 'at least one day is required' };
  for (const d of days) {
    if (typeof d !== 'string' || !VALID_DAYS.has(d)) {
      return { ok: false, error: `invalid day "${String(d)}" (expected Mon..Sun)` };
    }
  }
  const dedupedDays = (days as Window['days']).filter((d, i, arr) => arr.indexOf(d) === i);

  if (typeof b.startTime !== 'string' || !HHMM.test(b.startTime)) {
    return { ok: false, error: '`startTime` must be HH:MM (UTC)' };
  }
  if (typeof b.lengthMinutes !== 'number' || !Number.isFinite(b.lengthMinutes)) {
    return { ok: false, error: '`lengthMinutes` must be a number' };
  }
  if (b.lengthMinutes < 30 || b.lengthMinutes > 1440) {
    return { ok: false, error: '`lengthMinutes` must be between 30 and 1440' };
  }

  const applyTo = (b.applyTo ?? {}) as Record<string, unknown>;
  const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

  return {
    ok: true,
    window: {
      enabled,
      days: dedupedDays,
      startTime: b.startTime,
      lengthMinutes: Math.round(b.lengthMinutes),
      applyTo: {
        os: flag(applyTo.os, true),
        containers: flag(applyTo.containers, true),
        servicebay: flag(applyTo.servicebay, false),
      },
    },
  };
}

export async function GET() {
  try {
    const config = await getConfig();
    return NextResponse.json({ window: config.updateWindow ?? null });
  } catch (e) {
    return apiError(e, { tag: 'api:system:update-window', status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const result = validate(body);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await applyUpdateWindow(getExecutor(), result.window);
    await updateConfig({ updateWindow: result.window });

    return NextResponse.json({ window: result.window });
  } catch (e) {
    logger.error('api:system:update-window', 'Failed to apply update window', e);
    return apiError(e, { tag: 'api:system:update-window', status: 500 });
  }
}
