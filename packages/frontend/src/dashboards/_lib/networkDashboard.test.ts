import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import { computeEgoNodeIds } from './networkDashboard';

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
