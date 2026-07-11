import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import {
  computeEgoNodeIds,
  buildOrthogonalPath,
  topologyLayoutSignature,
  mergeGraphPreservingPositions,
  styleForEdgeKind,
  labelForEdgeKind,
  INFERRED_EDGE_COLOR,
  INFERRED_EDGE_DASHES,
  DECLARED_EDGE_COLOR,
  OBSERVED_EDGE_COLOR,
} from './networkDashboard';

// Minimal graph mirroring the map's shape:
//   internet → router → nginx → {hermes, auth, immich}
//   hermes also talks to ollama (a 1-hop neighbour off the public path)
//   abs is unrelated (router → nginx → abs)
const node = (id: string, type = 'service'): Node =>
  ({ id, type: 'custom', position: { x: 0, y: 0 }, data: { type, label: id } });

const edge = (source: string, target: string): Edge => ({ id: `e-${source}-${target}`, source, target });

const nodes: Node[] = [
  node('internet', 'internet'),
  node('router', 'router'),
  node('nginx', 'proxy'),
  node('hermes'),
  node('auth'),
  node('immich'),
  node('abs'),
  node('ollama'),
];

const edges: Edge[] = [
  edge('internet', 'router'),
  edge('router', 'nginx'),
  edge('nginx', 'hermes'),
  edge('nginx', 'auth'),
  edge('nginx', 'immich'),
  edge('nginx', 'abs'),
  edge('hermes', 'ollama'),
];

describe('edge-kind styling — inferred is visually distinct (#2175)', () => {
  it('styles an inferred edge with the violet dotted stroke', () => {
    const style = styleForEdgeKind('inferred', { strokeWidth: 2 });
    expect(style).toMatchObject({
      strokeWidth: 2,
      stroke: INFERRED_EDGE_COLOR,
      strokeDasharray: INFERRED_EDGE_DASHES,
    });
  });

  it('inferred stroke differs from declared and observed', () => {
    expect(INFERRED_EDGE_COLOR).not.toBe(DECLARED_EDGE_COLOR);
    expect(INFERRED_EDGE_COLOR).not.toBe(OBSERVED_EDGE_COLOR);
  });

  it('suffixes an inferred edge label with "(inferred)"', () => {
    expect(labelForEdgeKind('inferred', 'OLLAMA_URL')).toBe('OLLAMA_URL (inferred)');
    expect(labelForEdgeKind('inferred', undefined)).toBe('inferred');
  });
});

describe('computeEgoNodeIds', () => {
  it('returns an empty set when there is no focus', () => {
    expect(computeEgoNodeIds(nodes, edges, null).size).toBe(0);
    expect(computeEgoNodeIds(nodes, edges, undefined).size).toBe(0);
  });

  it('returns an empty set for an unknown focus id', () => {
    expect(computeEgoNodeIds(nodes, edges, 'does-not-exist').size).toBe(0);
  });

  it('keeps the focus node, its direct neighbours, and the internet→focus path', () => {
    const ego = computeEgoNodeIds(nodes, edges, 'hermes');
    // focus + 1-hop neighbours (nginx, ollama) + internet→hermes path (internet, router, nginx)
    expect(ego).toEqual(new Set(['hermes', 'nginx', 'ollama', 'internet', 'router']));
    // unrelated siblings are dropped — this is what makes the hub readable
    expect(ego.has('auth')).toBe(false);
    expect(ego.has('immich')).toBe(false);
    expect(ego.has('abs')).toBe(false);
  });

  it('keeps every direct sibling when the hub itself is focused', () => {
    const ego = computeEgoNodeIds(nodes, edges, 'nginx');
    expect(ego).toEqual(new Set(['nginx', 'router', 'hermes', 'auth', 'immich', 'abs', 'internet']));
    // ollama is 2 hops from nginx and off the public path → dropped
    expect(ego.has('ollama')).toBe(false);
  });

  it('treats edges as undirected (focus reachable via reversed orientation)', () => {
    // Edge stored target→source relative to flow direction must still link.
    const reversed: Edge[] = [edge('router', 'internet'), edge('nginx', 'router'), edge('hermes', 'nginx')];
    const ego = computeEgoNodeIds(nodes, reversed, 'hermes');
    expect(ego.has('internet')).toBe(true);
    expect(ego.has('router')).toBe(true);
    expect(ego.has('nginx')).toBe(true);
  });

  it('still returns the focus node when there is no internet node', () => {
    const noInternet = nodes.filter((n) => n.id !== 'internet');
    const noInternetEdges = edges.filter((e) => e.source !== 'internet' && e.target !== 'internet');
    const ego = computeEgoNodeIds(noInternet, noInternetEdges, 'hermes');
    expect(ego.has('hermes')).toBe(true);
    expect(ego.has('nginx')).toBe(true);
    expect(ego.has('ollama')).toBe(true);
  });
});

// #1792 — ubiquitous-dep suppression (#1785) drops the service→auth /
// service→dns edges before the graph reaches the frontend, stamping
// `behindAuth`/`usesDns` flags on the source nodes instead. The ego
// adjacency must re-derive those hub relationships from the flags so a
// hub's focus view isn't empty and a badge-only service shows its hubs.
describe('computeEgoNodeIds — suppressed ubiquitous hub deps (#1792)', () => {
  // Mirrors the post-suppression graph: NO service→auth / service→dns
  // edges exist; the dependency lives only in node metadata flags.
  const svc = (id: string, flags?: { behindAuth?: boolean; usesDns?: boolean }): Node => ({
    id,
    type: 'custom',
    position: { x: 0, y: 0 },
    data: { type: 'service', label: id, metadata: { ...(flags ?? {}) } },
  });

  const hubNodes: Node[] = [
    node('internet', 'internet'),
    node('router', 'router'),
    node('service-nginx', 'proxy'),
    node('service-auth'),
    node('service-adguard'),
    svc('service-immich', { behindAuth: true }),
    svc('service-vault', { behindAuth: true, usesDns: true }),
    svc('service-abs', { usesDns: true }),
    svc('service-ollama'), // no hub deps
  ];

  // Only the infrastructure spine survives suppression — no hub-spoke edges.
  const hubEdges: Edge[] = [
    edge('internet', 'router'),
    edge('router', 'service-nginx'),
    edge('service-nginx', 'service-auth'),
    edge('service-nginx', 'service-adguard'),
    edge('service-nginx', 'service-immich'),
    edge('service-nginx', 'service-vault'),
    edge('service-nginx', 'service-abs'),
    edge('service-nginx', 'service-ollama'),
  ];

  it('focusing the auth hub pulls in every service carrying the SSO badge', () => {
    const ego = computeEgoNodeIds(hubNodes, hubEdges, 'service-auth');
    // The behindAuth services are now visible even though no edge points at auth.
    expect(ego.has('service-immich')).toBe(true);
    expect(ego.has('service-vault')).toBe(true);
    // A DNS-only / no-dep service is NOT pulled in by the auth hub.
    expect(ego.has('service-abs')).toBe(false);
    expect(ego.has('service-ollama')).toBe(false);
    expect(ego.has('service-auth')).toBe(true);
  });

  it('focusing the dns hub pulls in every service carrying the DNS badge', () => {
    const ego = computeEgoNodeIds(hubNodes, hubEdges, 'service-adguard');
    expect(ego.has('service-vault')).toBe(true);
    expect(ego.has('service-abs')).toBe(true);
    expect(ego.has('service-immich')).toBe(false); // auth-only
    expect(ego.has('service-adguard')).toBe(true);
  });

  it('focusing a badge-only service surfaces the hub(s) it depends on', () => {
    // immich's only declared dep is auth (suppressed) — auth must appear.
    const immich = computeEgoNodeIds(hubNodes, hubEdges, 'service-immich');
    expect(immich.has('service-auth')).toBe(true);
    expect(immich.has('service-adguard')).toBe(false);

    // vault carries both badges — both hubs must appear.
    const vault = computeEgoNodeIds(hubNodes, hubEdges, 'service-vault');
    expect(vault.has('service-auth')).toBe(true);
    expect(vault.has('service-adguard')).toBe(true);
  });

  it('a service with no suppressed hub deps gains no extra hub neighbours', () => {
    const ego = computeEgoNodeIds(hubNodes, hubEdges, 'service-ollama');
    expect(ego.has('service-auth')).toBe(false);
    expect(ego.has('service-adguard')).toBe(false);
  });

  it('handles remote-host prefixed and .service-suffixed hub ids', () => {
    const remote = computeEgoNodeIds(
      [
        node('internet', 'internet'),
        node('Local:service-lldap.service'),
        svc('Local:service-immich.service', { behindAuth: true }),
      ],
      [],
      'Local:service-lldap.service',
    );
    // lldap maps to the auth token; immich (behindAuth) must be pulled in.
    expect(remote.has('Local:service-immich.service')).toBe(true);
  });
});

describe('buildOrthogonalPath — line-hops (#1784)', () => {
  it('inserts a ∩ arc on a horizontal run at a hop point', () => {
    // Straight horizontal edge 0,50 → 200,50 with a crossing at x=100.
    const { path } = buildOrthogonalPath(
      [{ x: 0, y: 50 }, { x: 200, y: 50 }],
      [{ x: 100, y: 50 }],
    );
    // An arc (A r r ...) appears; pen enters at x=94 and exits at x=106 (r=6).
    expect(path).toContain('A 6 6 0 0 1');
    expect(path).toContain('L 94,50');
    expect(path).toContain('106,50');
  });

  it('draws no arc when there are no hops (plain orthogonal run)', () => {
    const { path } = buildOrthogonalPath([{ x: 0, y: 50 }, { x: 200, y: 50 }]);
    expect(path).not.toContain(' A ');
    expect(path).toBe('M 0,50 L 200,50');
  });

  it('does not hop a vertical-only crossing on this run (wrong y)', () => {
    // A hop point at a different y than the run must be ignored here.
    const { path } = buildOrthogonalPath(
      [{ x: 0, y: 50 }, { x: 200, y: 50 }],
      [{ x: 100, y: 999 }],
    );
    expect(path).not.toContain(' A ');
  });
});

describe('#2119 topologyLayoutSignature', () => {
  const n = (id: string, status?: string): Node =>
    ({ id, type: 'custom', position: { x: 0, y: 0 }, data: { type: 'service', label: id, status } });
  const e = (s: string, t: string): Edge => ({ id: `e-${s}-${t}`, source: s, target: t });

  it('is identical when only node STATUS changes (no re-layout on a status poll)', () => {
    const a = topologyLayoutSignature([n('s1', 'up'), n('s2', 'up')], [e('s1', 's2')]);
    const b = topologyLayoutSignature([n('s1', 'down'), n('s2', 'up')], [e('s1', 's2')]);
    expect(a).toBe(b);
  });

  it('is order-independent (same ids in a different array order match)', () => {
    const a = topologyLayoutSignature([n('s1'), n('s2')], [e('s1', 's2')]);
    const b = topologyLayoutSignature([n('s2'), n('s1')], [e('s1', 's2')]);
    expect(a).toBe(b);
  });

  it('changes when a node is added', () => {
    const a = topologyLayoutSignature([n('s1')], []);
    const b = topologyLayoutSignature([n('s1'), n('s2')], []);
    expect(a).not.toBe(b);
  });

  it('changes when an edge is added', () => {
    const a = topologyLayoutSignature([n('s1'), n('s2')], []);
    const b = topologyLayoutSignature([n('s1'), n('s2')], [e('s1', 's2')]);
    expect(a).not.toBe(b);
  });

  it('changes when the collapsed set or focus changes', () => {
    const base = topologyLayoutSignature([n('s1'), n('s2')], [e('s1', 's2')]);
    expect(base).not.toBe(
      topologyLayoutSignature([n('s1'), n('s2')], [e('s1', 's2')], new Set(['s1'])),
    );
    expect(base).not.toBe(
      topologyLayoutSignature([n('s1'), n('s2')], [e('s1', 's2')], null, 's1'),
    );
  });
});

describe('#2119 mergeGraphPreservingPositions', () => {
  const laid = (id: string, x: number, status?: string): Node =>
    ({ id, type: 'custom', position: { x, y: x }, data: { type: 'service', label: id, status }, style: { width: 320 } });
  const fresh = (id: string, status?: string): Node =>
    ({ id, type: 'custom', position: { x: 0, y: 0 }, data: { type: 'service', label: id, status } });

  it('carries the laid-out position forward while taking the fresh data', () => {
    const { nodes } = mergeGraphPreservingPositions(
      [laid('s1', 100, 'up'), laid('s2', 200, 'up')],
      [],
      [fresh('s1', 'down'), fresh('s2', 'up')],
      [],
    );
    // positions preserved (NOT reset to the fresh {0,0})
    expect(nodes.find((x) => x.id === 's1')!.position).toEqual({ x: 100, y: 100 });
    expect(nodes.find((x) => x.id === 's2')!.position).toEqual({ x: 200, y: 200 });
    // fresh status flows through
    expect((nodes.find((x) => x.id === 's1')!.data as { status?: string }).status).toBe('down');
    // layout-sized style preserved
    expect(nodes.find((x) => x.id === 's1')!.style).toEqual({ width: 320 });
  });

  it('#2201 DROPS a fresh node that was not in the laid-out set (no (0,0) injection)', () => {
    // Simulates a poll after a collapsed layout: `fresh` carries the collapsed
    // service's containers (position {0,0}), but they were filtered out of the
    // laid-out set. They must NOT be re-introduced at the origin (which stacked
    // every container on its parent) — they're dropped until a real re-layout.
    const child = (id: string, parentId: string): Node =>
      ({ id, type: 'custom', position: { x: 0, y: 0 }, parentId, data: { type: 'container', label: id } });
    const { nodes } = mergeGraphPreservingPositions(
      [laid('s1', 100, 'up')], // laid-out set: just the (collapsed) service
      [],
      [fresh('s1', 'up'), child('c1', 's1'), child('c2', 's1')], // fresh carries the containers
      [],
    );
    expect(nodes.map((n) => n.id)).toEqual(['s1']); // containers dropped, not stacked at (0,0)
    expect(nodes.find((n) => n.id === 's1')!.position).toEqual({ x: 100, y: 100 });
  });

  it('#2201 preserves the aggregation fields (collapsed/summary/onToggle) across a merge', () => {
    const toggle = () => {};
    const laidAgg: Node = {
      id: 's1', type: 'custom', position: { x: 5, y: 5 },
      data: { type: 'service', label: 's1', status: 'up', collapsed: true, summary: { status: 'up' }, onToggle: toggle },
    };
    const { nodes } = mergeGraphPreservingPositions(
      [laidAgg], [],
      [fresh('s1', 'down')], [], // fresh has NO collapsed/summary/onToggle
    );
    const d = nodes[0].data as { status?: string; collapsed?: boolean; summary?: unknown; onToggle?: unknown };
    expect(d.status).toBe('down');        // fresh status flows through
    expect(d.collapsed).toBe(true);       // aggregation preserved (not lost to fresh)
    expect(d.summary).toEqual({ status: 'up' });
    expect(d.onToggle).toBe(toggle);      // toggle handler survives the poll
  });

  it('keeps the laid-out routed edge geometry, refreshing only styling/label', () => {
    const laidEdge: Edge = {
      id: 'e-s1-s2', source: 's1', target: 's2',
      data: { points: [{ x: 1, y: 2 }], originalId: 'orig' },
      style: { stroke: 'old' }, label: 'old',
    };
    const freshEdge: Edge = {
      id: 'different', source: 's1', target: 's2',
      data: { kind: 'observed' }, style: { stroke: 'new' }, label: 'new', animated: true,
    };
    const { edges } = mergeGraphPreservingPositions(
      [laid('s1', 1), laid('s2', 2)], [laidEdge],
      [fresh('s1'), fresh('s2')], [freshEdge],
    );
    const m = edges[0];
    expect(m.id).toBe('e-s1-s2'); // routed/generated id preserved
    expect((m.data as { points?: unknown }).points).toEqual([{ x: 1, y: 2 }]); // geometry preserved
    expect((m.data as { kind?: string }).kind).toBe('observed'); // fresh provenance merged
    expect(m.style).toEqual({ stroke: 'new' }); // styling refreshed
    expect(m.label).toBe('new');
  });
});
