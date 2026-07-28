'use client';

import { Box } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import ContainerList from '@/components/ContainerList';
import { Card } from '@/components/ui';

/** A request to open a container drawer on this tab, container id optional. */
export interface ContainersDrawerRequest {
  containerId?: string;
  mode: 'logs' | 'terminal';
  /** Bumped per request so re-asking for the same drawer re-opens it. */
  nonce?: number;
}

/**
 * Containers tab of a service's Operate page (IA slice 1, #2029 / spec §4.2).
 * Absorbs the per-service rows of the old `/health?tab=containers` surface so a
 * service's containers live on its one Operate page. Renders the canonical
 * shared ContainerList (#2367) — the exact component the box-wide Status →
 * Containers view uses — fed with only THIS service's attached containers, so
 * this view has the identical card layout AND the per-container Logs / Terminal
 * / Actions drawer (the "open terminal" action Status has).
 */
export default function OperateContainersTab({
  service,
  initialDrawer = null,
}: {
  service: ServiceViewModel;
  /**
   * Open a drawer as soon as this tab renders (#2391) — how the summary's
   * "Logs" quick action and the `?drawer=logs` deep link reach the real log
   * viewer. `containerId` is optional: without one we open the service's first
   * container, which is what "show me this service's logs" means. `nonce`
   * lets a repeat click re-open a drawer the user already closed.
   */
  initialDrawer?: ContainersDrawerRequest | null;
}) {
  const containers = (service.attachedContainers ?? []).map(c => ({
    ...c,
    nodeName: c.nodeName || service.nodeName,
  }));

  if (containers.length === 0) {
    return (
      <Card padding="lg" className="text-center text-text-muted">
        <Box className="w-10 h-10 mx-auto mb-3 opacity-20" />
        <p>No containers are currently running for this service.</p>
      </Card>
    );
  }

  // Resolve "the service's logs" to a concrete container the list can open.
  const drawerContainerId = initialDrawer ? initialDrawer.containerId ?? containers[0]?.id : undefined;

  return (
    <ContainerList
      containers={containers}
      initialDrawer={
        initialDrawer && drawerContainerId
          ? { containerId: drawerContainerId, mode: initialDrawer.mode, nonce: initialDrawer.nonce }
          : null
      }
    />
  );
}
