'use client';

import { useMemo } from 'react';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import {
  buildServiceViewModel,
  sortServicesByDisplayName,
  type ServiceViewModel,
} from '@servicebay/api-client';

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
export function useOperateServices(): { services: ServiceViewModel[]; loading: boolean } {
  const { data: twin, isConnected } = useDigitalTwin();

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

  const loading = !isConnected && services.length === 0;
  return { services, loading };
}

/** Find a single service by its routed name (`id` or `name`). */
export function useOperateService(name: string): {
  service: ServiceViewModel | null;
  loading: boolean;
} {
  const { services, loading } = useOperateServices();
  const service = useMemo(
    () => services.find(s => s.id === name || s.name === name) ?? null,
    [services, name],
  );
  return { service, loading };
}
