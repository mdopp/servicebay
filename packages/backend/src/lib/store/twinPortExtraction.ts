import yaml from 'js-yaml';
import { logger } from '../logger';

/**
 * Port-mapping extraction helpers used by `TwinStore.extractStaticPortsForService`.
 *
 * Split out from `twin.ts` to keep that file under the file-lines lint
 * ceiling. These don't depend on any TwinStore state — they just walk
 * static file content and call back into `pushPort` for each mapping
 * they find.
 */

export type PushPortFn = (
  hostPort?: number,
  containerPort?: number,
  protocol?: string,
  hostIp?: string,
) => void;

export function safeParsePort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** Walk a `kube` YAML document for `spec.containers[].ports[]` entries. */
export function extractPortsFromKubeYaml(
  yamlContent: string,
  serviceName: string | undefined,
  pushPort: PushPortFn,
): void {
  try {
    const docs = yaml.loadAll(yamlContent) as unknown[];
    docs.forEach(doc => {
      if (!doc || typeof doc !== 'object') return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spec = (doc as any).spec;
      if (!spec) return;
      const hostNetwork = Boolean(spec.hostNetwork);
      const containers = Array.isArray(spec.containers) ? spec.containers : [];
      containers.forEach((containerDoc: unknown) => {
        if (!containerDoc || typeof containerDoc !== 'object') return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const portsDef = Array.isArray((containerDoc as any).ports) ? (containerDoc as any).ports : [];
        portsDef.forEach((portDef: unknown) => {
          if (!portDef || typeof portDef !== 'object') return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const descriptor = portDef as any;
          const containerPort = safeParsePort(descriptor.containerPort ?? descriptor.container_port ?? descriptor.port);
          if (!containerPort) return;
          let hostPort = safeParsePort(descriptor.hostPort ?? descriptor.host_port);
          if (!hostPort && hostNetwork) hostPort = containerPort;
          pushPort(hostPort, containerPort, descriptor.protocol);
        });
      });
    });
  } catch (err) {
    logger.warn('TwinStore', `Failed to parse YAML for ${serviceName}`, err);
  }
}

/** Walk a Quadlet `.container` file for `Network=` + `PublishPort=` directives. */
export function extractPortsFromQuadletContainer(content: string, pushPort: PushPortFn): void {
  let hostNetwork = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('Network=')) {
      hostNetwork = trimmed.split('=')[1]?.trim() === 'host';
      continue;
    }
    if (!trimmed.startsWith('PublishPort=')) continue;

    const definition = trimmed.substring('PublishPort='.length);
    const [portPart, protoPart] = definition.split('/');
    const segments = portPart.split(':').filter(Boolean);
    let ip: string | undefined;
    let hostStr: string | undefined;
    let containerStr: string | undefined;

    if (segments.length === 3) {
      [ip, hostStr, containerStr] = segments;
    } else if (segments.length === 2) {
      [hostStr, containerStr] = segments;
    } else if (segments.length === 1) {
      hostStr = segments[0];
      containerStr = segments[0];
    }

    const containerPort = safeParsePort(containerStr);
    let hostPort = safeParsePort(hostStr);
    if (!hostPort && hostNetwork && containerPort) {
      hostPort = containerPort;
    }
    if (containerPort || hostPort) {
      pushPort(hostPort, containerPort ?? hostPort, protoPart, ip);
    }
  }
}
