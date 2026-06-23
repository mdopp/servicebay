'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { ServiceImageUpdate } from '@/hooks/useImageUpdates';
import { Button, Card, StatusDot } from '@/components/ui';

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
 * Stateless on the data side (the parent owns the fetch via `useImageUpdates`
 * so the same data backs both this overview and the per-card badges without two
 * round-trips). When the parent passes `onUpdate`, the banner becomes
 * actionable: a "Update now" button re-deploys every listed service (the same
 * `update` action the actions menu uses → pulls each new image, then restarts).
 * Without `onUpdate` it stays purely informational. The button owns only its
 * own in-flight flag; success/error feedback comes from the parent's toast.
 *
 * Migrated onto the design-system primitives (#2093): a `Card` with a
 * token-driven accent (an "update available" tint via the `accent` token, no
 * raw blue literals) + the shared `Button`/`StatusDot`. Dark-mode-correct by
 * construction — every colour resolves through a semantic CSS variable.
 */
export default function ImageUpdatesPendingBanner({
  updates,
  onUpdate,
}: {
  updates: ServiceImageUpdate[];
  /** Re-deploy every listed service to pull its latest image. Resolves when
   *  all attempts have run; rejections are surfaced by the parent's toast. */
  onUpdate?: (updates: ServiceImageUpdate[]) => Promise<void>;
}) {
  const [running, setRunning] = useState(false);

  if (updates.length === 0) return null;

  const handleUpdate = async () => {
    if (!onUpdate || running) return;
    setRunning(true);
    try {
      await onUpdate(updates);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card padding="md" className="border-accent/40 bg-accent/5">
      <div className="flex items-start gap-space-3">
        <div className="shrink-0 rounded-card bg-accent/10 p-1.5 text-accent">
          <Download size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-space-3">
            <div className="min-w-0">
              <div className="flex items-center gap-space-2 text-sm font-semibold text-text">
                <StatusDot state="warn" label="Update available" />
                {updates.length} service image update{updates.length === 1 ? '' : 's'} available
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                The registry is serving a newer image than what these services are running.
                Re-deploy a service to pull its latest image.
              </p>
            </div>
            {onUpdate && (
              <Button size="sm" onClick={handleUpdate} disabled={running}>
                {running ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {running ? 'Updating…' : 'Update now'}
              </Button>
            )}
          </div>
          <ul className="mt-space-2 space-y-1.5 text-xs text-text-muted">
            {updates.map(u => (
              <li key={`${u.service}:${u.image}`} className="flex flex-wrap items-center gap-space-2">
                <span className="font-mono font-medium text-text">{u.service}</span>
                <span className="break-all font-mono text-text-subtle">{u.image}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
