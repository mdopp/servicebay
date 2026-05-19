import { NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const REINSTALL_BANNER_TTL_MIN = 10;

/**
 * GET /api/system/reinstall — drives the "Welcome back — services
 * restoring" banner (#337). DELETE dismisses it. Migrated to
 * withApiHandler in #603.
 */
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const completedAt = config.reinstall?.completedAt;
  if (!completedAt) return NextResponse.json({ active: false });
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs)) return NextResponse.json({ active: false });
  const ageMin = (Date.now() - completedMs) / 60_000;
  if (ageMin > REINSTALL_BANNER_TTL_MIN) return NextResponse.json({ active: false });
  const minutesRemaining = Math.max(0, Math.ceil(REINSTALL_BANNER_TTL_MIN - ageMin));
  return NextResponse.json({ active: true, completedAt, minutesRemaining });
});

export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  if (!config.reinstall) return NextResponse.json({ ok: true, removed: false });
  const next = { ...config };
  delete next.reinstall;
  await saveConfig(next);
  return NextResponse.json({ ok: true, removed: true });
});
