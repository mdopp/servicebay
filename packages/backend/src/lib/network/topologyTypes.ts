/**
 * Shared port/topology helpers for network/service.ts and its peers.
 *
 * The graph-build code in `topologyAssembler.ts` and the per-node
 * assembly inside `NetworkService` both need a tolerant port number
 * parser and a handful of duck-typed port-mapping shapes. Lifting
 * them here keeps both consumers honest about the contract and
 * shrinks `service.ts` toward the per-seam shape #973 calls for.
 */

/** Tolerant port-number parser: accepts a finite positive number or
 *  its decimal-string twin. Anything else collapses to `undefined`,
 *  so call sites can `??` through a chain of candidate fields without
 *  ever propagating NaN / 0 / negative. */
export const resolvePortNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
};

/** Minimal subset of a Kubernetes Pod spec the network service walks
 *  to learn container port mappings — only the fields we actually
 *  read. The agent emits richer YAML but everything else is opaque
 *  here. */
export interface KubePodSpec {
  spec?: {
    containers?: {
      ports?: {
        hostPort?: number;
        containerPort?: number;
        hostIp?: string;
        protocol?: string;
      }[];
    }[];
  };
}

/** A port reference as it appears across our event sources. Container
 *  agents send number-or-object; FritzBox sends an object with
 *  `externalPort` / `internalPort`; reverse-proxy entries carry
 *  `host` / `containerPort`. Treat them all uniformly via
 *  `resolvePortNumber`. */
export type PortLike = number | {
  host?: number | string;
  hostPort?: number | string;
  port?: number | string;
  containerPort?: number | string;
  hostIp?: string;
  ip?: string;
};

/** FritzBox port-mapping entry as the gateway poller publishes it on
 *  the twin. Field naming varies by FritzBox firmware version, so the
 *  resolver always tries `externalPort ?? hostPort ?? port` and the
 *  internal-side equivalents. */
export interface FritzPortMapping {
  enabled?: boolean;
  targetIp?: string;
  internalClient?: string;
  internalPort?: number | string;
  externalPort?: number | string;
  hostPort?: number | string;
  port?: number | string;
  containerPort?: number | string;
  targetPort?: number | string;
}
