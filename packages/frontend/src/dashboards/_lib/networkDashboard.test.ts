import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import { computeEgoNodeIds, buildOrthogonalPath } from './networkDashboard';

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
