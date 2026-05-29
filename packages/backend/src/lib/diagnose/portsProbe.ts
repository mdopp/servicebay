/**
 * Helpers for the `Open TCP ports` probe inside
 * `src/app/api/system/diagnose/route.ts`.
 *
 * Hoisted out of the route so we can unit-test the
 * service+container walk without having to mock the entire diagnose
 * pipeline. The route assembles the listening-port list from `ss -ltn`
 * and asks `buildPortSourceMap` which of those ports are accounted for
 * in the digital twin, then renders unexpected ports with their owning
 * container/service via `renderUnexpectedPort`.
 *
 * The walk covers BOTH `twin.services.ports` AND
 * `twin.containers.ports` — sibling containers inside a pod (Immich's
 * Postgres at 5432, Redis at 6379) publish via the latter and used to
 * trip "unexpected" purely because the probe ignored them.
 */

export interface TwinPortService {
  name?: string;
  ports?: { hostPort?: number }[];
}

export interface TwinPortContainer {
  id?: string;
  names?: string[];
  ports?: { hostPort?: number }[];
}

/** Built-in system ports that aren't in the twin but are always expected. */
export const BUILTIN_PORT_SOURCES: ReadonlyArray<readonly [number, string]> = [
  [22, 'sshd'],
  [5888, 'servicebay'],
];

/** Build a `port → source-name` map from a twin node. First writer
 *  wins so service-level mappings (the meaningful name) take priority
 *  over the raw container names. */
/** Add each item's host ports to `out` under a derived label. First writer
 *  wins (existing entries are kept). Shared by the service + container passes
 *  so the per-item loop lives in one place. */
function addPortSources<T extends { ports?: { hostPort?: number }[] }>(
  out: Map<number, string>,
  items: T[] | undefined,
  label: (item: T) => string,
): void {
  for (const item of items ?? []) {
    const name = label(item);
    for (const p of item.ports ?? []) {
      if (typeof p.hostPort === 'number' && !out.has(p.hostPort)) {
        out.set(p.hostPort, name);
      }
    }
  }
}

export function buildPortSourceMap(
  services: TwinPortService[] | undefined,
  containers: TwinPortContainer[] | undefined,
): Map<number, string> {
  const out = new Map<number, string>(BUILTIN_PORT_SOURCES);
  // Services first so their (meaningful) name wins over raw container names.
  addPortSources(out, services, svc => svc.name ?? 'unknown service');
  addPortSources(
    out,
    containers,
    c => c.names?.[0]?.replace(/^\//, '') ?? `container ${c.id?.slice(0, 12) ?? 'unknown'}`,
  );
  return out;
}

/** Format an unexpected listening port with its owning container/service
 *  if known, or `(unknown)` if the twin has no source for it (process
 *  running outside ServiceBay's awareness). */
export function renderUnexpectedPort(port: string, sources: Map<number, string>): string {
  const n = parseInt(port, 10);
  if (!Number.isFinite(n)) return `${port} (unknown)`;
  const src = sources.get(n);
  return src ? `${port} (${src})` : `${port} (unknown)`;
}
