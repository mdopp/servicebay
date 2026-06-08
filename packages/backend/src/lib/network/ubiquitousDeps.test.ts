import { describe, it, expect } from 'vitest';
import { suppressUbiquitousDeps } from './ubiquitousDeps';
import type { NetworkNode, NetworkEdge } from './types';

function svc(id: string): NetworkNode {
  return { id, type: 'service', label: id, status: 'up' };
}

function edge(id: string, source: string, target: string, kind?: NetworkEdge['kind']): NetworkEdge {
  return { id, source, target, protocol: 'tcp', port: 0, state: 'active', kind };
}

describe('suppressUbiquitousDeps', () => {
  it('drops declared/observed edges to the auth hub and stamps behindAuth', () => {
    const nodes = [svc('service-auth'), svc('service-immich'), svc('service-vault')];
    const edges = [
      edge('e1', 'service-immich', 'service-auth', 'declared'),
      edge('e2', 'service-vault', 'service-auth', 'observed'),
    ];

    const { edges: kept, suppressed } = suppressUbiquitousDeps(nodes, edges);

    expect(suppressed).toBe(2);
    expect(kept).toHaveLength(0);
    const immich = nodes.find((n) => n.id === 'service-immich')!;
    expect(immich.metadata?.behindAuth).toBe(true);
    expect(immich.metadata?.ubiquitousDeps).toEqual(['auth']);
  });

  it('drops edges to the adguard DNS hub and stamps usesDns', () => {
    const nodes = [svc('service-adguard'), svc('service-immich')];
    const edges = [edge('e1', 'service-immich', 'service-adguard', 'declared')];

    const { edges: kept, suppressed } = suppressUbiquitousDeps(nodes, edges);

    expect(suppressed).toBe(1);
    expect(kept).toHaveLength(0);
    const immich = nodes.find((n) => n.id === 'service-immich')!;
    expect(immich.metadata?.usesDns).toBe(true);
    expect(immich.metadata?.ubiquitousDeps).toEqual(['dns']);
  });

  it('keeps the hub NODES and a service OTHER real edges', () => {
    const nodes = [svc('service-auth'), svc('service-immich'), svc('service-media')];
    const edges = [
      edge('hub', 'service-immich', 'service-auth', 'declared'),
      // Real cross-service flow — must survive.
      edge('flow', 'service-immich', 'service-media', 'observed'),
      // Structural spine — must survive even if it points at a hub.
      edge('gw', 'gateway', 'service-auth'),
    ];

    const { edges: kept } = suppressUbiquitousDeps(nodes, edges);

    // Hub node still present.
    expect(nodes.find((n) => n.id === 'service-auth')).toBeDefined();
    // Cross-flow + gateway-spine kept; only the hub-spoke dropped.
    expect(kept.map((e) => e.id).sort()).toEqual(['flow', 'gw']);
  });

  it('does not suppress structural (no-kind / gateway / proxy / manual) edges to a hub', () => {
    const nodes = [svc('service-auth'), svc('service-immich')];
    const edges = [
      edge('plain', 'service-immich', 'service-auth'), // no kind
      { ...edge('manual', 'service-immich', 'service-auth'), isManual: true },
    ];

    const { edges: kept, suppressed } = suppressUbiquitousDeps(nodes, edges);

    expect(suppressed).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it('handles both auth and dns deps on one node', () => {
    const nodes = [svc('service-auth'), svc('service-adguard'), svc('service-immich')];
    const edges = [
      edge('a', 'service-immich', 'service-auth', 'declared'),
      edge('d', 'service-immich', 'service-adguard', 'declared'),
    ];

    const { suppressed } = suppressUbiquitousDeps(nodes, edges);

    expect(suppressed).toBe(2);
    const immich = nodes.find((n) => n.id === 'service-immich')!;
    expect(immich.metadata?.behindAuth).toBe(true);
    expect(immich.metadata?.usesDns).toBe(true);
    expect((immich.metadata?.ubiquitousDeps as string[]).sort()).toEqual(['auth', 'dns']);
  });

  it('resolves hubs across remote-node prefixes and .service suffix', () => {
    const nodes = [svc('box2:service-auth.service'), svc('box2:service-paperless')];
    const edges = [edge('e', 'box2:service-paperless', 'box2:service-auth.service', 'declared')];

    const { suppressed } = suppressUbiquitousDeps(nodes, edges);

    expect(suppressed).toBe(1);
    expect(nodes.find((n) => n.id === 'box2:service-paperless')!.metadata?.behindAuth).toBe(true);
  });

  it('no-ops when there is no hub node in the graph', () => {
    const nodes = [svc('service-immich'), svc('service-media')];
    const edges = [edge('e', 'service-immich', 'service-media', 'declared')];

    const { edges: kept, suppressed } = suppressUbiquitousDeps(nodes, edges);

    expect(suppressed).toBe(0);
    expect(kept).toEqual(edges);
  });
});
