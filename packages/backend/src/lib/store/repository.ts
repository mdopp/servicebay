import { DigitalTwinStore } from './twin';
import type { NodeTwin, GatewayState, ProxyState } from './twin';
import type { EnrichedContainer, ServiceUnit } from '../agent/types';

/**
 * Encapsulated store access selectors (#841).
 * Isolates direct references to the global DigitalTwinStore singleton.
 */

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

export function getStoreSnapshot() {
  return DigitalTwinStore.getInstance().getSnapshot();
}

// --- Write operations ---

export function setServerName(name: string | null): void {
  DigitalTwinStore.getInstance().setServerName(name);
}

export function dismissUnmanagedBundle(nodeId: string, bundleId: string): boolean {
  return DigitalTwinStore.getInstance().dismissUnmanagedBundle(nodeId, bundleId);
}

// --- Compound selectors ---

export function getUnmanagedBundles(nodeId: string): import('../unmanaged/bundleShared').ServiceBundle[] {
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
