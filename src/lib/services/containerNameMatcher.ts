/**
 * Container-name matching for managed services (#589).
 *
 * Lifted from ServiceManager.listServices, which used to inline all
 * four strategies. Pure functions on plain inputs so the matcher is
 * unit-testable without spinning up the Digital Twin.
 *
 * systemd-generated container names depend on how Podman + Quadlet
 * chose to expand the source YAML. We don't know which one at read
 * time, so we generate every plausible candidate up front and pick
 * whichever the twin actually has:
 *
 *   - `<baseName>`                  — simple/legacy
 *   - `systemd-<baseName>`          — Quadlet root
 *   - `<baseName>-<baseName>`       — typical Pod member
 *   - `<podName>` / `<podName>-<containerName>` — from kube YAML
 *   - `<baseName>-<containerName>`  — same, with the unit's stem
 *
 * Plus the raw container names declared in the YAML if any. The
 * dedup keeps the candidate set small.
 */

import type { EnrichedContainer } from '../agent/types';

/** Pod / Deployment document shape used across the listServices path.
 *  The matcher only reads `metadata.name` and `spec.containers[].name`,
 *  but the downstream metadata-extraction block in
 *  `ServiceManager.listServices` also reads labels, annotations, and a
 *  few spec fields off the same parsed doc — so the interface is wider
 *  than the matcher strictly needs. Adding new readers here is fine;
 *  the parser swallows shape mismatches into an empty array. */
export interface PodLikeDoc {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    hostNetwork?: boolean;
    containers?: Array<{
      name?: string;
      image?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ports?: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env?: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      volumeMounts?: any[];
    }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    volumes?: any[];
  };
}

/**
 * Build the deduplicated set of container names that could plausibly
 * correspond to a managed service named `baseName`. `podDocs` is the
 * list of YAML documents parsed from the unit's `.yml` file; pass an
 * empty array for plain `.container` quadlets.
 */
export function buildExpectedContainerNames(baseName: string, podDocs: PodLikeDoc[] = []): string[] {
  const expected: string[] = [
    baseName,
    `systemd-${baseName}`,
    `${baseName}-${baseName}`,
  ];
  for (const doc of podDocs) {
    if (doc?.metadata?.name) {
      expected.push(doc.metadata.name);
    }
    if (doc?.spec?.containers) {
      for (const c of doc.spec.containers) {
        if (!c?.name) continue;
        expected.push(c.name);
        expected.push(`${baseName}-${c.name}`);
        if (doc.metadata?.name) {
          expected.push(`${doc.metadata.name}-${c.name}`);
        }
      }
    }
  }
  // Dedup while preserving insertion order — earlier (simpler) names
  // get priority in the matcher's `find` below.
  return Array.from(new Set(expected));
}

/**
 * Pick the most useful container for a managed service from the
 * twin's container list. Returns the first port-bearing match (these
 * are the ones the UI cares about for ports/health), falling back to
 * the first match of any kind, or undefined if no candidate names
 * appear in the twin.
 *
 * Comparison strips the leading `/` Podman adds to container names.
 */
export function pickContainerForService(
  twinContainers: ReadonlyArray<EnrichedContainer>,
  expectedNames: ReadonlyArray<string>,
): EnrichedContainer | undefined {
  const expected = new Set(expectedNames);
  const candidates = twinContainers.filter(c =>
    Array.isArray(c.names) && c.names.some(n => expected.has(n.replace(/^\//, ''))),
  );
  if (candidates.length === 0) return undefined;
  return candidates.find(c => c.ports && c.ports.length > 0) ?? candidates[0];
}
