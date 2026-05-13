/**
 * GET + PUT /api/system/os-update-window
 *
 * Owns the "OS update window" feature: Fedora CoreOS's Zincati daemon
 * pulls + reboots automatically; without a window the host can reboot
 * any time of day. We expose three knobs (days, start time, length)
 * and write them as a TOML drop-in under /etc/zincati/config.d/.
 *
 * GET returns the operator's stored intent (`config.osUpdateWindow`),
 * never re-parses the on-disk TOML. PUT validates + persists the
 * intent, renders the TOML, copies it into place via `sudo install`
 * (the `core` user has NOPASSWD sudo on a stock FCoS box), and
 * restarts zincati so the new window takes effect on the next update
 * check. When `enabled: false` we remove the file rather than
 * writing a "no-op" config, so Zincati falls back to its default
 * `immediate` strategy.
 */
import { NextResponse } from 'next/server';
import { getConfig, updateConfig, type AppConfig } from '@/lib/config';
import { getExecutor } from '@/lib/executor';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

type Window = NonNullable<AppConfig['osUpdateWindow']>;

const ZINCATI_PATH = '/etc/zincati/config.d/55-servicebay-window.toml';
const ZINCATI_TMP = '/tmp/55-servicebay-window.toml';
const VALID_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function renderToml(w: Window): string {
  // `periodic` is Zincati's vocabulary for "only reboot inside this
  // window". Image pulls + finalisations still happen outside the
  // window; only the actual reboot is deferred. The lockfile-style
  // header comment makes the file easy to recognise during host
  // debugging — it gets re-rendered on every save, so don't expect
  // hand edits to survive.
  return `# Managed by ServiceBay — Settings → System → OS update window.
# Edits in this file are overwritten on the next save.

[updates]
strategy = "periodic"

[[updates.periodic.window]]
days = [ ${w.days.map(d => `"${d}"`).join(', ')} ]
start_time = "${w.startTime}"
length_minutes = ${w.lengthMinutes}
`;
}

function validate(body: unknown): { ok: true; window: Window } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const enabled = b.enabled;
  if (typeof enabled !== 'boolean') return { ok: false, error: '`enabled` must be a boolean' };

  // When disabling, the other fields are still required so the UI
  // can pre-fill them when the operator toggles back on. We keep the
  // stored intent intact; only the on-disk TOML changes.
  if (!Array.isArray(b.days)) return { ok: false, error: '`days` must be an array' };
  const days = b.days as unknown[];
  if (days.length === 0) return { ok: false, error: 'at least one day is required' };
  for (const d of days) {
    if (typeof d !== 'string' || !VALID_DAYS.has(d)) {
      return { ok: false, error: `invalid day "${String(d)}" (expected Mon..Sun)` };
    }
  }
  // Deduplicate without changing operator order — `Set` would
  // shuffle, but explicit filter preserves intent for the UI.
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

  return { ok: true, window: { enabled, days: dedupedDays, startTime: b.startTime, lengthMinutes: Math.round(b.lengthMinutes) } };
}

export async function GET() {
  try {
    const config = await getConfig();
    return NextResponse.json({ window: config.osUpdateWindow ?? null });
  } catch (e) {
    return apiError(e, { tag: 'api:system:os-update-window', status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const result = validate(body);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const window = result.window;
    const executor = getExecutor();

    if (window.enabled) {
      // Two-step write: `writeFile` lands under /tmp (writable by the
      // agent's unprivileged user), then `sudo install` copies it into
      // /etc/zincati/config.d/ with sane perms. Atomic from Zincati's
      // perspective — it only ever sees a complete file at the final
      // path. The temp file is left behind for diagnostics; it's tiny
      // and gets overwritten next save.
      await executor.writeFile(ZINCATI_TMP, renderToml(window));
      await executor.exec(`sudo install -m 0644 -o root -g root ${ZINCATI_TMP} ${ZINCATI_PATH}`);
      await executor.exec(`sudo systemctl restart zincati`);
    } else {
      // Disabling means "forget that we manage this". rm -f so it's
      // idempotent — operators may have already removed the file by
      // hand. After the rm Zincati reverts to its default
      // `immediate` strategy on next reload.
      await executor.exec(`sudo rm -f ${ZINCATI_PATH}`);
      await executor.exec(`sudo systemctl restart zincati`);
    }

    await updateConfig({ osUpdateWindow: window });
    return NextResponse.json({ window });
  } catch (e) {
    logger.error('api:system:os-update-window', 'Failed to apply update window', e);
    return apiError(e, { tag: 'api:system:os-update-window', status: 500 });
  }
}
