import { NextResponse } from 'next/server';
import { getConfig, saveConfig } from '@/lib/config';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

// Banner auto-dismisses after this many minutes from completedAt.
// Long enough to cover slow first-boot service restore on a cold
// box, short enough to never show on a "normal" session.
const REINSTALL_BANNER_TTL_MIN = 10;

/**
 * GET /api/system/reinstall
 *
 * Tell the dashboard whether to show the "Welcome back — services
 * restoring" banner. Returns `active: false` when:
 *   - no re-install was recorded (true fresh install)
 *   - the completedAt timestamp is older than the TTL (banner expired)
 *   - the operator already dismissed it (handled by DELETE)
 *
 * See #337.
 */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const config = await getConfig();
    const completedAt = config.reinstall?.completedAt;
    if (!completedAt) {
      return NextResponse.json({ active: false });
    }
    const completedMs = Date.parse(completedAt);
    if (!Number.isFinite(completedMs)) {
      return NextResponse.json({ active: false });
    }
    const ageMin = (Date.now() - completedMs) / 60_000;
    if (ageMin > REINSTALL_BANNER_TTL_MIN) {
      return NextResponse.json({ active: false });
    }
    const minutesRemaining = Math.max(0, Math.ceil(REINSTALL_BANNER_TTL_MIN - ageMin));
    return NextResponse.json({
      active: true,
      completedAt,
      minutesRemaining,
    });
  } catch (e) {
    return apiError(e, { tag: 'api:system:reinstall:get', status: 500 });
  }
}

/**
 * DELETE /api/system/reinstall
 *
 * Dismiss the banner. Clears `config.reinstall` outright so subsequent
 * GETs report `active: false`.
 */
export async function DELETE(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const config = await getConfig();
    if (!config.reinstall) {
      return NextResponse.json({ ok: true, removed: false });
    }
    const next = { ...config };
    delete next.reinstall;
    await saveConfig(next);
    return NextResponse.json({ ok: true, removed: true });
  } catch (e) {
    return apiError(e, { tag: 'api:system:reinstall:delete', status: 500 });
  }
}
