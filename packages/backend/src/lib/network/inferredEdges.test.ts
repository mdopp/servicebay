import { describe, it, expect } from 'vitest';
import {
  parseEnvHostPort,
  inferEnvEdges,
  anchorFloatingNodes,
  type EnvSource,
  type EnvInferenceTarget,
} from './inferredEdges';
import { suppressUbiquitousDeps } from './ubiquitousDeps';
import type { NetworkEdge, NetworkNode } from './types';

describe('parseEnvHostPort (#2175)', () => {
  it('parses http URLs, capturing scheme + port', () => {
    expect(parseEnvHostPort('http://ollama:11434')).toEqual({
      host: 'ollama',
      port: 11434,
      protocol: 'http',
    });
  });

  it('parses https URLs and ignores the path/query', () => {
    expect(parseEnvHostPort('https://Whisper:10300/v1/audio?x=1')).toEqual({
      host: 'whisper',
      port: 10300,
      protocol: 'https',
    });
  });

  it('parses a bare host:port as tcp', () => {
    expect(parseEnvHostPort('localhost:11434')).toEqual({
      host: 'localhost',
      port: 11434,
      protocol: 'tcp',
    });
  });

  it('rejects values without a host:port', () => {
    expect(parseEnvHostPort('just-a-string')).toBeNull();
    expect(parseEnvHostPort('')).toBeNull();
    expect(parseEnvHostPort('supersecret')).toBeNull();
    // A lone :port (no host) must not match.
    expect(parseEnvHostPort(':5432')).toBeNull();
    // A word:word secret pair must not match (port isn't numeric).
    expect(parseEnvHostPort('user:password')).toBeNull();
  });

  it('rejects out-of-range ports', () => {
    expect(parseEnvHostPort('http://ollama:99999')).toBeNull();
  });
});

const target = (nodeId: string, aliases: string[], hostPorts: number[] = []): EnvInferenceTarget => ({
  nodeId,
  aliases,
  hostPorts,
});

describe('inferEnvEdges — host-named resolution (#2175)', () => {
  const targets = [
    target('service-ollama.service', ['ollama']),
    target('service-solaris-tts.service', ['solaris-tts']),
  ];

  it('emits a kind:"inferred" edge labelled with the env var name', () => {
    const env: EnvSource[] = [
      { nodeId: 'service-solaris-tts.service', name: 'OLLAMA_URL', value: 'http://ollama:11434' },
    ];
    const edges = inferEnvEdges(env, targets, []);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'service-solaris-tts.service',
      target: 'service-ollama.service',
      label: 'OLLAMA_URL',
      kind: 'inferred',
      protocol: 'http',
      port: 11434,
    });
  });

  it('does not resolve an env host to the source node itself', () => {
    const env: EnvSource[] = [
      { nodeId: 'service-ollama.service', name: 'SELF', value: 'http://ollama:11434' },
    ];
    expect(inferEnvEdges(env, targets, [])).toHaveLength(0);
  });

  it('skips an inferred edge when a prior source already covers the pair (dedupe)', () => {
    const env: EnvSource[] = [
      { nodeId: 'service-solaris-tts.service', name: 'OLLAMA_URL', value: 'http://ollama:11434' },
    ];
    const existing: NetworkEdge[] = [
      {
        id: 'declared-x',
        source: 'service-solaris-tts.service',
        target: 'service-ollama.service',
        protocol: 'tcp',
        port: 11434,
        state: 'active',
        kind: 'declared',
      },
    ];
    expect(inferEnvEdges(env, targets, existing)).toHaveLength(0);
  });

  it('collapses two env vars naming the same target into one edge', () => {
    const env: EnvSource[] = [
      { nodeId: 'service-solaris-tts.service', name: 'A', value: 'http://ollama:11434' },
      { nodeId: 'service-solaris-tts.service', name: 'B', value: 'ollama:11434' },
    ];
    expect(inferEnvEdges(env, targets, [])).toHaveLength(1);
  });
});

describe('inferEnvEdges — localhost port-only resolution (#2175)', () => {
  it('resolves a loopback host by unique host-port match', () => {
    const targets = [target('service-ollama.service', ['ollama'], [11434])];
    const env: EnvSource[] = [
      { nodeId: 'service-ha.service', name: 'OLLAMA', value: 'http://localhost:11434' },
    ];
    const edges = inferEnvEdges(env, targets, []);
    expect(edges).toHaveLength(1);
    expect(edges[0].target).toBe('service-ollama.service');
  });

  it('does not guess when the loopback port matches multiple targets', () => {
    const targets = [
      target('service-a.service', ['a'], [8080]),
      target('service-b.service', ['b'], [8080]),
    ];
    const env: EnvSource[] = [
      { nodeId: 'service-ha.service', name: 'X', value: 'http://127.0.0.1:8080' },
    ];
    expect(inferEnvEdges(env, targets, [])).toHaveLength(0);
  });
});

describe('anchorFloatingNodes — fallback anchor (#2175)', () => {
  const svc = (id: string, extra: Partial<NetworkNode> = {}): NetworkNode => ({
    id,
    type: 'service',
    label: id,
    status: 'up',
    ...extra,
  });

  it('anchors an edge-less service node to the host root', () => {
    const nodes: NetworkNode[] = [svc('service-lonely.service')];
    const anchors = anchorFloatingNodes(nodes, [], 'gateway');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      source: 'gateway',
      target: 'service-lonely.service',
      kind: 'inferred',
    });
  });

  it('leaves a node that already has an edge untouched', () => {
    const nodes: NetworkNode[] = [svc('service-connected.service')];
    const edges: NetworkEdge[] = [
      {
        id: 'e1',
        source: 'gateway',
        target: 'service-connected.service',
        protocol: 'tcp',
        port: 80,
        state: 'active',
      },
    ];
    expect(anchorFloatingNodes(nodes, edges, 'gateway')).toHaveLength(0);
  });

  it('only anchors service-type nodes, not groups/devices/the anchor itself', () => {
    const nodes: NetworkNode[] = [
      svc('gateway', { type: 'gateway' }),
      svc('group-x', { type: 'group' }),
      svc('device-y', { type: 'device' }),
      svc('service-real.service'),
    ];
    const anchors = anchorFloatingNodes(nodes, [], 'gateway');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].target).toBe('service-real.service');
  });

  it('does not anchor a node nested inside a parent group', () => {
    const nodes: NetworkNode[] = [
      svc('service-child.service', { parentNode: 'group-parent' }),
    ];
    expect(anchorFloatingNodes(nodes, [], 'gateway')).toHaveLength(0);
  });
});

// Ordering regression (#2175 box-verify #4 red): the anchor pass must run on
// the POST-suppression edge set. A service node whose ONLY edge is a
// suppressible ubiquitous dep (claude-dev→auth) looks "connected" before
// suppression but ends edge-less after — it MUST get an anchor. This encodes
// the exact getGraph sequence: suppressUbiquitousDeps → anchorFloatingNodes.
describe('anchor after ubiquitous-dep suppression — ordering (#2175)', () => {
  const svc = (id: string, extra: Partial<NetworkNode> = {}): NetworkNode => ({
    id,
    type: 'service',
    label: id,
    status: 'up',
    ...extra,
  });

  it('anchors a node whose ONLY edge is a suppressed auth dep', () => {
    const nodes: NetworkNode[] = [
      svc('service-auth.service'),
      svc('service-claude-dev.service'),
    ];
    // claude-dev's sole edge is a declared dependency on the auth hub.
    const edges: NetworkEdge[] = [
      {
        id: 'declared-claude-dev-auth',
        source: 'service-claude-dev.service',
        target: 'service-auth.service',
        protocol: 'tcp',
        port: 0,
        state: 'active',
        kind: 'declared',
      },
    ];

    // Step 1 — suppression removes the claude-dev→auth hub-spoke edge.
    const { edges: afterSuppress, suppressed } = suppressUbiquitousDeps(nodes, edges);
    expect(suppressed).toBe(1);
    expect(afterSuppress).toHaveLength(0);

    // Step 2 — anchoring on the post-suppression set now anchors claude-dev
    // (it would NOT have been anchored on the pre-suppression `edges`, which
    // is exactly the box-verify #4 bug).
    const anchors = anchorFloatingNodes(nodes, afterSuppress, 'gateway');
    const claudeDevAnchor = anchors.find(
      (a) => a.target === 'service-claude-dev.service',
    );
    expect(claudeDevAnchor).toBeDefined();
    expect(claudeDevAnchor).toMatchObject({ source: 'gateway', kind: 'inferred' });

    // The claude-dev card ends with >=1 edge.
    const finalEdges = [...afterSuppress, ...anchors];
    expect(
      finalEdges.some(
        (e) =>
          e.source === 'service-claude-dev.service' ||
          e.target === 'service-claude-dev.service',
      ),
    ).toBe(true);
  });

  it('does NOT anchor a node that keeps a real surviving edge after suppression', () => {
    const nodes: NetworkNode[] = [
      svc('service-auth.service'),
      svc('service-webapp.service'),
    ];
    // webapp has an auth dep (suppressed) AND a real gateway edge (survives).
    const edges: NetworkEdge[] = [
      {
        id: 'declared-webapp-auth',
        source: 'service-webapp.service',
        target: 'service-auth.service',
        protocol: 'tcp',
        port: 0,
        state: 'active',
        kind: 'declared',
      },
      {
        id: 'gateway-webapp',
        source: 'gateway',
        target: 'service-webapp.service',
        protocol: 'tcp',
        port: 443,
        state: 'active',
      },
    ];

    const { edges: afterSuppress } = suppressUbiquitousDeps(nodes, edges);
    const anchors = anchorFloatingNodes(nodes, afterSuppress, 'gateway');
    // No anchor for webapp — its gateway edge survived (no double edge).
    expect(anchors.find((a) => a.target === 'service-webapp.service')).toBeUndefined();
  });
});
