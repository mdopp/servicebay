'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/system/stacks/image-updates', { cache: 'no-store' });
      if (!res.ok) return;
      const data: ImageUpdatesResponse = await res.json();
      setUpdates(Array.isArray(data?.services) ? data.services : []);
    } catch {
      // Best-effort: a failed check just leaves no badges — never block the
      // dashboard (feedback_dont_mask_failures: we don't claim "up to date",
      // we simply show nothing until the next successful poll).
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const available = useMemo(() => updates.filter(u => u.updateAvailable), [updates]);
  const availableServices = useMemo(
    () => new Set(available.map(u => u.service)),
    [available],
  );

  return { available, availableServices, loaded, refresh };
}
