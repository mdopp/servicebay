'use client';

import { useState, useCallback } from 'react';
import { Trash2 } from 'lucide-react';

import { SectionHeading } from '@/components/ui';
import { Button } from '@/components/ui';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import type { ServiceStackGroup } from '@/dashboards/_lib/servicesDashboard';

/**
 * Stack group header (#2081) — the labelled divider above each stack's service
 * rows on the /services overview, plus the per-stack WIPE action.
 *
 * The wipe is DESTRUCTIVE and scoped to ONE stack:
 *  - It hits the per-stack endpoint POST /api/system/stacks/<name>/wipe with the
 *    `WIPE-<name>` confirmation token. It NEVER calls the system-wide
 *    /api/system/stacks/reset (that nukes every service on the node — total data
 *    loss 2026-05-15; feedback_destructive_install_options).
 *  - A blocking ConfirmModal requires the operator to type `WIPE-<name>` before
 *    the action fires (no toast-only / one-click teardown).
 *  - Core / atomic-wipe stacks (basic/auth) never render the button — `wipeable`
 *    is false for them (feedback_tui_desired_state_install), and the backend
 *    hard-refuses them too.
 *  - The ungrouped bucket has no single stack to scope to, so no wipe button.
 */

interface StackGroupHeaderProps {
  group: ServiceStackGroup;
  /** Called after a successful wipe so the parent can refresh its data. */
  onWiped?: () => void;
}

export default function StackGroupHeader({ group, onWiped }: StackGroupHeaderProps) {
  const { addToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const stackName = group.manifest?.name ?? group.id;
  const confirmToken = `WIPE-${stackName}`;

  const runWipe = useCallback(async () => {
    if (!group.wipeable || running) return;
    setRunning(true);
    try {
      // Scoped, per-stack wipe — NOT the system-wide reset.
      const res = await fetch(`/api/system/stacks/${encodeURIComponent(stackName)}/wipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirmToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      const failed = (data.failed ?? []).length;
      const handlerFails = (data.capabilityFailures ?? []).length;
      addToast(
        failed + handlerFails === 0 ? 'success' : 'info',
        `Wiped ${group.label}`,
        `Removed ${data.deleted?.length ?? 0} service${data.deleted?.length === 1 ? '' : 's'}` +
          (failed > 0 ? ` (${failed} failed)` : '') +
          (handlerFails > 0 ? `; ${handlerFails} cross-service cleanup issue${handlerFails === 1 ? '' : 's'}` : ''),
      );
      setConfirmOpen(false);
      onWiped?.();
    } catch (e) {
      addToast('error', 'Wipe failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }, [group.wipeable, group.label, running, stackName, confirmToken, addToast, onWiped]);

  return (
    <>
      <SectionHeading
        description={`${group.services.length} service${group.services.length === 1 ? '' : 's'}`}
        actions={
          group.wipeable ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              aria-label={`Wipe ${group.label} stack`}
            >
              <Trash2 size={14} />
              Wipe stack
            </Button>
          ) : undefined
        }
      >
        {group.label}
      </SectionHeading>

      {group.wipeable && (
        <ConfirmModal
          isOpen={confirmOpen}
          title={`Wipe the "${group.label}" stack`}
          isDestructive
          requireTypedConfirm
          resourceName={confirmToken}
          isLoading={running}
          confirmText={running ? 'Wiping…' : 'Wipe stack'}
          message={
            <>
              This stops every service in the <strong>{group.label}</strong> stack, deletes
              their on-disk data, and clears their cross-service registrations (Authelia OIDC
              client, NPM proxy host, AdGuard rewrite, credentials). Only this one stack is
              affected. This cannot be undone.
            </>
          }
          onConfirm={runWipe}
          onCancel={() => {
            if (running) return;
            setConfirmOpen(false);
          }}
        />
      )}
    </>
  );
}
