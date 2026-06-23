'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Re-poll schedule (ms) used by `verifyAfterUpdate` after a successful update
 * action. The registry image-update report lags the actual pull/restart: an
 * immediate re-fetch can still see the *old* running digest because the
 * container hasn't restarted (or re-reported) yet, which is why the banner
 * appeared to "stick" until a manual reload (#2106). We re-check on a short,
 * bounded back-off and stop as soon as the report is clean — never spinning
 * forever. An immediate refresh runs first (offset 0), then these delays.
 */
const VERIFY_REPOLL_DELAYS_MS = [1500, 4000];

/**
 * One service's running-vs-registry image comparison, as returned by
 * `GET /api/system/stacks/image-updates` (#1859, child 1 of #1858). The
 * backend shape is `ServiceImageUpdate` in `@/lib/imageDigest`; this mirrors
 * its public fields (the frontend can't import the backend module via
 * `@/lib`, which resolves to the backend package — memory
 * reference_at_lib_alias_is_backend).
 */
export interface ServiceImageUpdate {
  service: string;
  image: string;
  runningDigest: string | null;
  registryDigest: string | null;
  /** True iff both digests are known and differ. */
  updateAvailable: boolean;
}

interface ImageUpdatesResponse {
  services: ServiceImageUpdate[];
}

/**
 * Fetch the per-service image-update report once on mount. Distinct from the
 * schema-version "template upgrade" check (that compares registry *schema
 * versions*; this compares running-vs-registry *image digests*) — the two
 * surfaces are independent.
 *
 * Returns the affected entries (`updateAvailable === true`) for the overview
 * section, a `Set` of their service names for fast per-card lookup, plus a
 * `refresh` to re-poll after an update action.
 */
export function useImageUpdates() {
  const [updates, setUpdates] = useState<ServiceImageUpdate[]>([]);
  const [loaded, setLoaded] = useState(false);

  /**
   * Re-fetch the report once. Returns the count of services still reporting an
   * available update so callers can decide whether another re-poll is worth it.
   * A failed fetch returns `null` (unknown) and leaves the current state alone —
   * we never wipe the banner on a transient error (feedback_dont_mask_failures:
   * we don't claim "up to date" on a failed check, we keep what we last knew).
   */
  const refresh = useCallback(async (): Promise<number | null> => {
    try {
      const res = await fetch('/api/system/stacks/image-updates', { cache: 'no-store' });
      if (!res.ok) return null;
      const data: ImageUpdatesResponse = await res.json();
      const services = Array.isArray(data?.services) ? data.services : [];
      setUpdates(services);
      return services.filter(u => u.updateAvailable).length;
    } catch {
      // Best-effort: a failed check just leaves the existing badges in place —
      // never block the dashboard and never falsely clear the banner.
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  /**
   * Refresh after a successful update action. Because the registry report lags
   * the pull/restart (#2106), one immediate refresh can still show the stale
   * entry, so we re-check on the bounded `VERIFY_REPOLL_DELAYS_MS` back-off and
   * stop early the moment the report is clean (`count === 0`). This hides the
   * banner without a page reload while never spinning forever; on a persistent
   * report (e.g. the update genuinely didn't take) the banner correctly stays.
   */
  const verifyAfterUpdate = useCallback(async (): Promise<void> => {
    const remaining = await refresh();
    if (remaining === 0) return;
    for (const delay of VERIFY_REPOLL_DELAYS_MS) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if ((await refresh()) === 0) return;
    }
  }, [refresh]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async image-update check on mount
    refresh();
  }, [refresh]);

  const available = useMemo(() => updates.filter(u => u.updateAvailable), [updates]);
  const availableServices = useMemo(
    () => new Set(available.map(u => u.service)),
    [available],
  );

  return { available, availableServices, loaded, refresh, verifyAfterUpdate };
}
