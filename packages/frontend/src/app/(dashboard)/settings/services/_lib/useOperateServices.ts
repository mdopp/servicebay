'use client';

import { useMemo } from 'react';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import {
  buildServiceViewModel,
  sortServicesByDisplayName,
  type ServiceViewModel,
} from '@servicebay/api-client';

/**
 * How much we actually know about the Operate service list (#2629).
 *
 * These are three *different* claims and a consumer must never collapse them
 * into one boolean: "we have no answer yet" is not "there is no such service",
 * and neither of those is "we couldn't ask". The per-service page used to treat
 * anything that wasn't `loading` as an answer, so it rendered a definite
 * "Service <name> was not found" during the window between the socket
 * connecting and the digital twin's first snapshot arriving.
 *
 * - `loading`      — no synced snapshot yet; **no grounds for any verdict**.
 * - `ready`        — a synced snapshot is in hand; an absent service is
 *                    genuinely absent.
 * - `unavailable`  — the realtime channel is offline and nothing ever arrived;
 *                    the list failed to load, which is not the same as empty.
 */
export type OperateLoadState = 'loading' | 'ready' | 'unavailable';

/**
 * The managed services that get a per-service Operate page (#1957 / slice 2 of
 * #1950). A service is the grouping unit (feedback_services_are_the_grouping_unit):
 * one Operate page = one service = Health + Settings + Actions.
 *
 * Derived from the same digital twin the Services dashboard reads, via the same
 * `buildServiceViewModel`, so the Operate list never drifts from the dashboard.
 * Only Quadlet-managed services are listed here — external links, the gateway
 * and unmanaged discovery bundles are not "operable" services and stay on the
 * Services dashboard.
 */
export function useOperateServices(): {
  services: ServiceViewModel[];
  state: OperateLoadState;
} {
  const { data: twin, isNodeSynced } = useDigitalTwin();
  const { status: connection } = useConnectionStatus();

  const services = useMemo<ServiceViewModel[]>(() => {
    if (!twin || !twin.nodes) return [];

    const built: ServiceViewModel[] = [];
    Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
      if (!Array.isArray(nodeState.services)) return;
      nodeState.services.forEach(unit => {
        const vm = buildServiceViewModel({
          unit,
          nodeName,
          nodeState,
          proxyRoutes: twin.proxyState?.routes,
          installedTemplates: twin.installedTemplates,
        });
        if (vm) built.push(vm);
      });
    });

    // De-dupe on node:name, preferring the kube-managed / active definition —
    // same precedence the Services dashboard applies.
    const unique = new Map<string, ServiceViewModel>();
    built.forEach(service => {
      const key = `${service.nodeName}:${service.name}`;
      const existing = unique.get(key);
      if (!existing) {
        unique.set(key, service);
        return;
      }
      const isNewManaged = service.type === 'kube';
      const isExistingManaged = existing.type === 'kube';
      if (isNewManaged && !isExistingManaged) {
        unique.set(key, service);
        return;
      }
      if (isExistingManaged && !isNewManaged) return;
      if (service.active && !existing.active) {
        unique.set(key, service);
        return;
      }
      if (service.yamlPath && !existing.yamlPath) unique.set(key, service);
    });

    return sortServicesByDisplayName(Array.from(unique.values()));
  }, [twin]);

  // `isConnected` on its own is NOT grounds for a verdict: the socket reports
  // connected before the digital twin's first snapshot lands, and an empty list
  // in that window is ignorance, not absence (#2629). The Services and
  // Containers dashboards already guard on `isNodeSynced()` for the same
  // reason (`isConnected && !isNodeSynced() && length === 0` → still hydrating);
  // this is the same condition stated positively.
  const synced = isNodeSynced() || services.length > 0;
  const state: OperateLoadState = synced
    ? 'ready'
    : connection === 'offline'
      ? 'unavailable'
      : 'loading';

  return { services, state };
}

/** Find a single service by its routed name (`id` or `name`). */
export function useOperateService(name: string): {
  service: ServiceViewModel | null;
  state: OperateLoadState;
} {
  const { services, state } = useOperateServices();
  const service = useMemo(
    () => services.find(s => s.id === name || s.name === name) ?? null,
    [services, name],
  );
  return { service, state };
}
