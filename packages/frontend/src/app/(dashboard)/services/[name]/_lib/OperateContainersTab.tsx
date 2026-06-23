'use client';

import { Box } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import ContainerList from '@/components/ContainerList';
import { Card } from '@/components/ui';

/**
 * Containers tab of a service's Operate page (IA slice 1, #2029 / spec §4.2).
 * Absorbs the per-service rows of the old `/health?tab=containers` surface so a
 * service's containers live on its one Operate page. Reuses ContainerList (the
 * same component the box-wide containers view uses) fed with only THIS service's
 * attached containers, so the per-container logs/shell/actions stay available.
 */
export default function OperateContainersTab({ service }: { service: ServiceViewModel }) {
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

  return <ContainerList containers={containers} />;
}
