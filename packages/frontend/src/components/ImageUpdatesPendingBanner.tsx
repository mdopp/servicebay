'use client';

import { Download } from 'lucide-react';
import type { ServiceImageUpdate } from '@/hooks/useImageUpdates';

/**
 * Pending-updates overview for managed stacks (#1860, child 2 of #1858).
 *
 * Lists every installed service whose running image digest differs from the
 * digest the registry now serves for the same tag (data from
 * `GET /api/system/stacks/image-updates`, #1859). The counterpart per-card
 * badge lives on `ServiceCard`; this banner is the at-a-glance roll-up,
 * mirroring `TemplateUpgradesPendingBanner`'s placement and visual language.
 *
 * This is DISTINCT from the schema-version "template upgrade" banner: that
 * one compares registry *schema versions* (and offers a re-deploy), this one
 * compares *image digests*. They render independently; neither affects the
 * other.
 *
 * Stateless on purpose — the parent owns the fetch (`useImageUpdates`) so the
 * same data backs both this overview and the per-card badges without two
 * round-trips.
 */
export default function ImageUpdatesPendingBanner({ updates }: { updates: ServiceImageUpdate[] }) {
  if (updates.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/20">
      <div className="p-4 flex items-start gap-3">
        <div className="shrink-0 p-1.5 rounded bg-blue-100 dark:bg-blue-800/30 text-blue-700 dark:text-blue-300">
          <Download size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-gray-900 dark:text-white">
            {updates.length} service image update{updates.length === 1 ? '' : 's'} available
          </div>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            The registry is serving a newer image than what these services are running.
            Re-deploy a service to pull its latest image.
          </p>
          <ul className="mt-2 space-y-1.5 text-xs text-gray-700 dark:text-gray-300">
            {updates.map(u => (
              <li key={`${u.service}:${u.image}`} className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-medium">{u.service}</span>
                <span className="text-gray-500 dark:text-gray-400 font-mono break-all">{u.image}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
