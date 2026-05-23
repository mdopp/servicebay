import { DigitalTwinStore } from './twin';
import type { NodeTwin, GatewayState, ProxyState, MigrationHistoryEntry } from './twin';
import type { EnrichedContainer, ServiceUnit, ServiceHealth } from '../agent/types';
import type { ServiceBundle } from '../unmanaged/bundleShared';

/**
 * Encapsulated store access selectors (#841 / #842).
 *
 * Every read of the global `DigitalTwinStore` singleton must go through
 * one of these selectors. The `check:invariants` script blocks new
 * `DigitalTwinStore.getInstance()` calls anywhere outside this file —
 * raising the budget needs an explicit ratchet bump.
 *
 * Reads come first (the bulk of the API); writes are grouped at the end
 * and kept narrow so future CQRS work can lift them into a separate
 * command bus without touching every call site again.
 */

export type StoreSnapshot = ReturnType<DigitalTwinStore['getSnapshot']>;

// --- Read selectors ---

export function getNodeTwins(): Record<string, NodeTwin> {
  return DigitalTwinStore.getInstance().nodes;
}

export function getNodeTwin(nodeId: string): NodeTwin | undefined {
  return DigitalTwinStore.getInstance().nodes[nodeId];
}

export function getContainers(nodeId: string): EnrichedContainer[] {
  return DigitalTwinStore.getInstance().nodes[nodeId]?.containers ?? [];
}

export function getServices(nodeId: string): ServiceUnit[] {
  return DigitalTwinStore.getInstance().nodes[nodeId]?.services ?? [];
}

export function getGateway(): GatewayState {
  return DigitalTwinStore.getInstance().gateway;
}

export function getProxyState(): ProxyState {
  return DigitalTwinStore.getInstance().proxyState;
}

export function getStoreSnapshot(): StoreSnapshot {
  return DigitalTwinStore.getInstance().getSnapshot();
}

export function getNodeIds(): string[] {
  return Object.keys(DigitalTwinStore.getInstance().nodes);
}

export function getUnmanagedBundles(nodeId: string): ServiceBundle[] {
  return DigitalTwinStore.getInstance().nodes[nodeId]?.unmanagedBundles ?? [];
}

export function getFirstNodeHostname(): string | null {
  const store = DigitalTwinStore.getInstance();
  const firstNode = Object.values(store.nodes)[0];
  if (!firstNode?.resources) return null;

  const hostname = firstNode.resources.os?.hostname;
  if (hostname && hostname !== 'localhost' && !hostname.endsWith('.localdomain')) {
    return hostname;
  }

  const network = firstNode.resources.network;
  if (network) {
    for (const addrs of Object.values(network)) {
      const pub = addrs.find(a => a.family === 'IPv4' && !a.internal);
      if (pub) return pub.address;
    }
  }

  return null;
}

// --- Write selectors ---

export function setServerName(name: string | null): void {
  DigitalTwinStore.getInstance().setServerName(name);
}

export function dismissUnmanagedBundle(nodeId: string, bundleId: string): boolean {
  return DigitalTwinStore.getInstance().dismissUnmanagedBundle(nodeId, bundleId);
}

export function setServiceHealth(nodeName: string, serviceName: string, health: ServiceHealth): void {
  DigitalTwinStore.getInstance().setServiceHealth(nodeName, serviceName, health);
}

export function clearServiceHealth(nodeName: string, serviceName: string): void {
  DigitalTwinStore.getInstance().clearServiceHealth(nodeName, serviceName);
}

export function updateGateway(update: Partial<GatewayState>): void {
  DigitalTwinStore.getInstance().updateGateway(update);
}

export function recordMigrationEvent(nodeId: string, entry: MigrationHistoryEntry): void {
  DigitalTwinStore.getInstance().recordMigrationEvent(nodeId, entry);
}
