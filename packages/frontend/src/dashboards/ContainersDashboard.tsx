'use client';

import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import DashboardHydrationGate, { type HydrationPhase } from '@/components/DashboardHydrationGate';
import { Search } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ContainerList, { type ContainerListItem } from '@/components/ContainerList';
import { logger, type ServiceBundle } from '@servicebay/api-client';
import {
    groupContainersByStack,
    type StackSummaryLite,
} from './_lib/servicesDashboard';

export default function ContainersDashboard() {
  const { data: twin, isConnected, isNodeSynced } = useDigitalTwin();
  const searchParams = useSearchParams();
  const containerIdParam = searchParams?.get('containerId');
  const drawerParam = searchParams?.get('drawer');

  const [searchQuery, setSearchQuery] = useState('');
    const [showInfra, setShowInfra] = useState(false);
    const [stackSummaries, setStackSummaries] = useState<StackSummaryLite[]>([]);

    // Stack membership so Status→Containers groups mirror the /services
    // stack-grouping (#2095). Non-fatal: on failure the grouper falls back to
    // per-service / "Other containers" buckets.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/system/stacks', { cache: 'no-store' });
                if (!res.ok) throw new Error('Failed to load stacks');
                const payload = await res.json();
                const stacks: StackSummaryLite[] = Array.isArray(payload?.stacks)
                    ? payload.stacks.map((s: StackSummaryLite) => ({ name: s.name, manifest: s.manifest ?? null }))
                    : [];
                if (!cancelled) setStackSummaries(stacks);
            } catch (error) {
                logger.error('ContainersDashboard', 'Failed to load stacks', error);
            }
        })();
        return () => { cancelled = true; };
    }, []);

  const containerParentMap = useMemo(() => {
    const map = new Map<string, { type: 'service' | 'bundle'; name: string }>();
    if (!twin || !twin.nodes) return map;

    Object.values(twin.nodes).forEach(nodeState => {
        (nodeState.services || []).forEach(service => {
            (service.associatedContainerIds || []).forEach(containerId => {
                if (!containerId) return;
                const displayName = service.name.replace(/\.service$/, '');
                map.set(containerId, { type: 'service', name: displayName });
            });
        });

        const unmanagedBundles = Array.isArray((nodeState as { unmanagedBundles?: ServiceBundle[] }).unmanagedBundles)
            ? (nodeState as { unmanagedBundles?: ServiceBundle[] }).unmanagedBundles!
            : [];
        unmanagedBundles.forEach(bundle => {
            (bundle.containers || []).forEach(containerSummary => {
                if (!containerSummary.id) return;
                map.set(containerSummary.id, { type: 'bundle', name: bundle.displayName });
            });
        });
    });

    return map;
  }, [twin]);

  // The canonical shape the shared ContainerList renders: the enriched twin
  // container plus its owning node + parent service/bundle.
  const containers = useMemo((): ContainerListItem[] => {
    if (!twin || !twin.nodes) return [];
    const list: ContainerListItem[] = [];
    Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
        nodeState.containers.forEach(ec => {
            list.push({ ...ec, nodeName, parent: containerParentMap.get(ec.id) });
        });
    });
    return list;
  }, [containerParentMap, twin]);

  const loading = !isConnected && containers.length === 0;
  const waitingForSync = isConnected && !isNodeSynced() && containers.length === 0;

  const filteredContainers = useMemo(() => {
      let filtered = containers;

      if (!showInfra) {
          filtered = filtered.filter(c => !c.isInfra);
      }

      if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filtered = filtered.filter(c =>
              (c.names ?? []).some(n => n.toLowerCase().includes(q)) ||
              (c.id ?? '').toLowerCase().includes(q) ||
              (c.image ?? '').toLowerCase().includes(q) ||
              (c.nodeName ? c.nodeName.toLowerCase().includes(q) : false)
          );
      }

      return filtered;
  }, [containers, searchQuery, showInfra]);

  // Group containers under the same stack identity the /services view uses
  // (#2095): each container's parent service maps to its owning stack, with a
  // Core services group for infra/system containers and an "Other containers"
  // bucket for everything stack-less. Mirrors groupServicesByStack's optic.
  const containerGroups = useMemo(
    () =>
      groupContainersByStack(
        filteredContainers,
        c => ({ serviceName: c.parent?.type === 'service' ? c.parent.name : null, isInfra: c.isInfra }),
        stackSummaries,
      ),
    [filteredContainers, stackSummaries],
  );

  const initialDrawer = containerIdParam
    ? { containerId: containerIdParam, mode: (drawerParam === 'terminal' ? 'terminal' : 'logs') as 'logs' | 'terminal' }
    : null;

    return (
        <div className="h-full flex flex-col relative">
              <PageHeader title="Container Engine" showBack={false} helpId="container-engine">
                        <div className="flex flex-col gap-3 w-full md:flex-row md:items-center">
                            <div className="relative flex-1 min-w-[200px]">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-subtle" />
                                <input
                                    type="text"
                                    placeholder="Search containers..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full pl-9 pr-4 py-2 rounded-lg border border-border bg-surface text-sm text-text focus:ring-2 focus:ring-accent outline-none"
                                />
                            </div>
                            <label className="flex items-center gap-2 text-sm text-text-muted select-none">
                                <input
                                    type="checkbox"
                                    checked={showInfra}
                                    onChange={(e) => setShowInfra(e.target.checked)}
                                    className="rounded border-border text-accent focus:ring-accent"
                                />
                                Show infrastructure containers
                            </label>
                        </div>
                    </PageHeader>

            <div className="flex-1 overflow-y-auto p-4">
                {loading || waitingForSync ? (
                        <DashboardHydrationGate
                            phase={(loading ? 'socket' : 'sync') as HydrationPhase}
                        />
                    ) : filteredContainers.length === 0 ? (
                        <div className="text-center text-text-muted mt-10">
                            {containers.length > 0 ? 'No containers match your filters.' : 'No active containers found.'}
                        </div>
                    ) : (
                        <ContainerList groups={containerGroups} showParentBadge initialDrawer={initialDrawer} />
                    )}
            </div>
        </div>
    );
}
