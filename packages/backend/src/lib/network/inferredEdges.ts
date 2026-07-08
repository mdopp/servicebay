/**
 * Env-target inference + fallback anchoring (#2175).
 *
 * Some services bind localhost and declare no `servicebay.dependencies`,
 * show no proxy route, and never surface a sampled TCP flow — so the four
 * existing edge sources (gateway port-forward, nginx proxy, observed flow,
 * declared dep) produce *zero* edges and their cards float as loose,
 * disconnected components on the map (claude-dev, solaris-tts,
 * solaris-whisper, exhibitor-dashboard).
 *
 * This module adds two best-effort, purely structural passes that run
 * AFTER the four existing sources in `NetworkService.getNodeGraph`:
 *
 *   1. Env-target inference — scan each service's rendered pod-manifest
 *      `env` for a value that names another service/container by host+port
 *      (`http(s)://<host>:<port>` or a bare `<host>:<port>`). When `<host>`
 *      resolves to a known service/container/host-port binding in the same
 *      graph, emit a `kind: 'inferred'` edge labelled with the env-var name.
 *      Deduped against edges the earlier sources already drew for the same
 *      (source → target) pair.
 *
 *   2. Fallback anchor — any service node STILL edge-less after (1) and the
 *      four prior sources anchors to the host's root node (the `gateway`)
 *      with a `kind: 'inferred'` anchor edge, so no card renders fully
 *      disconnected.
 *
 * Both passes are pure functions over already-assembled nodes/edges so they
 * unit-test in isolation without a live Digital Twin.
 */

import yaml from 'js-yaml';
import type { NetworkEdge, NetworkNode } from './types';

/** A service's resolvable identity in the graph, for env-host matching. */
export interface EnvInferenceTarget {
  /** The graph node id this target maps to (edge destination). */
  nodeId: string;
  /** Lowercased names this target answers to: service base name, container
   *  names, and any host IPs it binds. Matched against the env `<host>`. */
  aliases: string[];
  /** Host-side ports this target listens on, for the optional port check. */
  hostPorts: number[];
}

/** One env var of one source service, ready for host:port extraction. */
export interface EnvSource {
  /** Graph node id of the service the env belongs to (edge source). */
  nodeId: string;
  /** Env var name — becomes the inferred edge's label. */
  name: string;
  /** Env var value — scanned for a `host:port` reference. */
  value: string;
}

interface HostPortRef {
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'tcp';
}

/** A single env var of a pod container, as read from a rendered pod yaml. */
export interface PodEnvVar {
  name: string;
  value: string;
}

// Minimal structural view of a rendered pod-manifest yaml — just the
// container env entries this module needs. Kept local so we never widen to
// `any` when walking untrusted yaml.
interface PodManifestShape {
  spec?: {
    containers?: Array<{
      env?: Array<{ name?: unknown; value?: unknown }>;
    }>;
  };
}

// Structural view of a network node's `rawData` (typed `any` on the node) —
// only the fields env-inference resolves against.
interface ServiceRawDataShape {
  name?: unknown;
  containers?: Array<{ names?: unknown }>;
  ports?: Array<number | { host?: unknown }>;
}

/**
 * Extract every `{name, value}` env pair from a rendered pod-manifest yaml.
 * Returns [] on a parse failure or a manifest with no env — best-effort, a
 * bad yaml must never break graph assembly.
 */
export function extractPodEnv(yamlContent: string): PodEnvVar[] {
  let manifest: PodManifestShape;
  try {
    manifest = yaml.load(yamlContent) as PodManifestShape;
  } catch {
    return [];
  }
  const out: PodEnvVar[] = [];
  for (const container of manifest?.spec?.containers ?? []) {
    for (const env of container.env ?? []) {
      if (typeof env?.name === 'string' && typeof env?.value === 'string') {
        out.push({ name: env.name, value: env.value });
      }
    }
  }
  return out;
}

/**
 * Derive a node's resolvable identity for env-host matching: aliases (label,
 * base template name from the `service-<name>` id, container names, bound IP)
 * plus its host-side ports. Pure over the node's already-assembled data.
 */
export function buildEnvInferenceTarget(node: NetworkNode): EnvInferenceTarget {
  const aliases = new Set<string>();
  aliases.add(node.label.toLowerCase());
  const idMatch = node.id.match(/service-([^:]+?)(?:\.service)?$/);
  if (idMatch) aliases.add(idMatch[1].toLowerCase());

  const raw = (node.rawData ?? {}) as ServiceRawDataShape;
  if (typeof raw.name === 'string') {
    aliases.add(raw.name.replace(/\.service$/, '').toLowerCase());
  }
  for (const container of raw.containers ?? []) {
    const names = Array.isArray(container.names) ? container.names : [];
    for (const cn of names) {
      if (typeof cn === 'string') aliases.add(cn.replace(/^\//, '').toLowerCase());
    }
  }
  if (node.ip) aliases.add(String(node.ip).toLowerCase());

  const hostPorts: number[] = [];
  for (const p of raw.ports ?? []) {
    const hp = typeof p === 'number' ? p : p.host;
    if (typeof hp === 'number' && hp > 0) hostPorts.push(hp);
  }

  return { nodeId: node.id, aliases: Array.from(aliases), hostPorts };
}

/**
 * Extract a single `<host>:<port>` reference from an env value. Accepts:
 *   - `http://host:port` / `https://host:port` (path/query ignored)
 *   - a bare `host:port`
 * Returns null when the value carries no host:port pair. Only the FIRST
 * match is used — env values naming multiple endpoints are rare and a
 * single inferred edge per var keeps the map readable.
 */
export function parseEnvHostPort(value: string): HostPortRef | null {
  if (!value) return null;
  const trimmed = value.trim();

  // http(s)://host:port — capture scheme so the edge protocol is right.
  const url = trimmed.match(/^(https?):\/\/([A-Za-z0-9._-]+):(\d{1,5})(?:[/?#]|$)/);
  if (url) {
    const port = Number.parseInt(url[3], 10);
    if (port > 0 && port <= 65535) {
      return { host: url[2].toLowerCase(), port, protocol: url[1] as 'http' | 'https' };
    }
  }

  // Bare host:port (no scheme, no path). Host must contain a letter or a dot
  // so we don't match a lone `:5432` or a `key:secret` pair of words.
  const bare = trimmed.match(/^([A-Za-z0-9._-]*[A-Za-z.][A-Za-z0-9._-]*):(\d{1,5})$/);
  if (bare) {
    const port = Number.parseInt(bare[2], 10);
    if (port > 0 && port <= 65535) {
      return { host: bare[1].toLowerCase(), port, protocol: 'tcp' };
    }
  }

  return null;
}

/**
 * Resolve an env `<host>` against the known targets. A localhost/loopback
 * host (127.*, ::1, localhost, 0.0.0.0) can't name a target by hostname, so
 * we fall back to matching purely on the port among host-network binders —
 * exactly the localhost-bound-service case this feature exists to connect.
 */
function resolveTarget(
  ref: HostPortRef,
  sourceNodeId: string,
  targets: EnvInferenceTarget[],
): EnvInferenceTarget | null {
  const loopback =
    ref.host === 'localhost' ||
    ref.host === '0.0.0.0' ||
    ref.host === '::1' ||
    ref.host.startsWith('127.');

  if (loopback) {
    // Match on port alone, but never resolve to the source itself.
    const byPort = targets.filter(
      t => t.nodeId !== sourceNodeId && t.hostPorts.includes(ref.port),
    );
    return byPort.length === 1 ? byPort[0] : null;
  }

  const byName = targets.find(
    t => t.nodeId !== sourceNodeId && t.aliases.includes(ref.host),
  );
  return byName ?? null;
}

/**
 * Env-target inference pass. Returns the inferred edges to append. Pure:
 * no I/O, no mutation of the inputs.
 *
 * @param envSources   every (service node, env var) pair in the graph
 * @param targets      resolvable identities of graph nodes
 * @param existingEdges edges the four prior sources already drew — an
 *                      inferred edge for a (source → target) pair they
 *                      already cover is skipped (dedupe).
 */
export function inferEnvEdges(
  envSources: EnvSource[],
  targets: EnvInferenceTarget[],
  existingEdges: NetworkEdge[],
): NetworkEdge[] {
  // Dedupe key = source|target. Skip inferred if any prior edge exists for
  // the pair (either direction is NOT deduped — direction is meaningful).
  const covered = new Set<string>();
  for (const e of existingEdges) covered.add(`${e.source}|${e.target}`);

  const out: NetworkEdge[] = [];
  // Guard against two env vars on the same service naming the same target
  // (e.g. WHISPER_URL + STT_URL both → ollama) drawing duplicate edges.
  const emitted = new Set<string>();

  for (const src of envSources) {
    const ref = parseEnvHostPort(src.value);
    if (!ref) continue;

    const target = resolveTarget(ref, src.nodeId, targets);
    if (!target) continue;

    const pairKey = `${src.nodeId}|${target.nodeId}`;
    if (covered.has(pairKey) || emitted.has(pairKey)) continue;
    emitted.add(pairKey);

    out.push({
      id: `inferred-${src.nodeId}-${target.nodeId}-${ref.port}`,
      source: src.nodeId,
      target: target.nodeId,
      // Label carries the env-var origin; the FE suffixes "(inferred)".
      label: src.name,
      protocol: ref.protocol,
      port: ref.port,
      state: 'active',
      kind: 'inferred',
    });
  }

  return out;
}

/**
 * Fallback-anchor pass. Any service node with no edge on either end (after
 * every prior source, including env inference) gets a single anchor edge to
 * `anchorNodeId` (the host's `gateway`/root), so no card floats.
 *
 * Only `type: 'service'` nodes are anchored — infra/group/device nodes are
 * either already connected or intentionally standalone. The anchor node
 * itself is never anchored to itself.
 */
export function anchorFloatingNodes(
  nodes: NetworkNode[],
  edges: NetworkEdge[],
  anchorNodeId: string,
): NetworkEdge[] {
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }

  const out: NetworkEdge[] = [];
  for (const node of nodes) {
    if (node.type !== 'service') continue;
    if (node.id === anchorNodeId) continue;
    if (connected.has(node.id)) continue;
    // Skip nodes nested inside a parent group — a `parentNode` already gives
    // them a visual home, so they don't float.
    if (node.parentNode) continue;

    out.push({
      id: `inferred-anchor-${node.id}`,
      source: anchorNodeId,
      target: node.id,
      label: 'host',
      protocol: 'tcp',
      port: 0,
      state: 'active',
      kind: 'inferred',
    });
    // Mark connected so a second floating node doesn't also… (each gets its
    // own anchor edge; connected-set is only read from `edges`, not mutated).
    connected.add(node.id);
  }

  return out;
}
