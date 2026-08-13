/**
 * Boundary validation for `POST /api/services` container creation (#2503).
 *
 * Everything this body carries ends up on a shell or in a privileged file
 * write on the box:
 *
 *   name              → `~/.config/containers/systemd/<name>.kube`, and
 *                       `python3 ~/.local/share/servicebay/post-deploy/<name>.py`
 *                       built as an unquoted shell string
 *   yamlFileName      → `~/.config/containers/systemd/<yamlFileName>`
 *   extraFiles[].path → `mkdir -p <dir>` (unquoted) plus a `write_file` that
 *                       auto-retries with `sudo: true`
 *   postDeployEnv     → `KEY='value'` lines in a file bash `source`s
 *   migrations        → a script written to the box and run with python3
 *
 * The rule this module encodes: the request may say *which* service, *where*
 * inside that service's own storage, and *which* registry-shipped script —
 * never the script body itself, and never a path outside the service's scope.
 * Executable content (post-deploy.py, migration bodies) is resolved
 * server-side from the template registry by the route, exactly the way the
 * install runner used to resolve it before putting it on the wire.
 */

import { z } from 'zod';
import yaml from 'js-yaml';
import {
  ServiceName,
  QuadletFileName,
  HostFilePath,
  EnvVarName,
  MigrationScriptFileName,
} from '../api/schemas';

/** Where template data lives on the box when config doesn't say otherwise. */
export const DEFAULT_TEMPLATE_DATA_DIR = '/mnt/data/stacks';

/**
 * The custom-container creation body. `.strict()` is load-bearing: it is what
 * makes an inline `postDeployScript` (or any future executable field someone
 * adds to a caller) a hard 400 instead of a silently-honoured payload.
 */
export const CreateServiceRequest = z.object({
  name: ServiceName,
  kubeContent: z.string().min(1).max(1_000_000),
  yamlContent: z.string().min(1).max(1_000_000),
  yamlFileName: QuadletFileName,
  /** Companion config/asset files. Paths are scope-checked separately. */
  extraFiles: z
    .array(z.object({ path: HostFilePath, content: z.string().max(20_000_000) }).strict())
    .max(500)
    .optional(),
  /** Values for the template's own post-deploy/migration scripts. */
  postDeployEnv: z.record(EnvVarName, z.string()).optional(),
  /** Registry the template came from (`Built-in`, `Local`, a registry name). */
  templateSource: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 @_.\-]*$/, 'invalid template source')
    .optional(),
  /**
   * Migration steps to run, BY REFERENCE. The bodies are read from the
   * registry server-side; a step the registry doesn't ship is rejected.
   */
  migrations: z
    .array(z.object({
      filename: MigrationScriptFileName,
      fromVersion: z.number().int().nonnegative(),
      toVersion: z.number().int().nonnegative(),
    }).strict())
    .max(50)
    .optional(),
}).strict();

export type CreateServiceRequest = z.infer<typeof CreateServiceRequest>;

/** Strip trailing slashes so `<root>/` and `<root>` compare the same. */
function normalizeRoot(dir: string): string {
  return dir.replace(/\/+$/, '');
}

/**
 * Directories this deploy is allowed to write companion files into:
 *   - every absolute `hostPath.path` the pod manifest itself declares —
 *     the wizard derives a config file's target from exactly these
 *     (install/manifestAssembler.ts resolveConfigFilePaths), and
 *   - this service's own subdirectory of the template data dir, where its
 *     asset files land (`<DATA_DIR>/<template>/skills/…`, registry.ts
 *     walkSkillsDir). NOT the whole data dir — a deploy has no business
 *     writing into another service's storage.
 *
 * A malformed manifest just yields fewer roots — the caller fails closed.
 */
export function collectAllowedExtraFileRoots(
  yamlContent: string,
  dataDir: string,
  serviceName: string,
): string[] {
  const roots = new Set<string>();
  const trimmedDataDir = normalizeRoot((dataDir || '').trim());
  if (trimmedDataDir.startsWith('/') && serviceName.length > 0) {
    roots.add(`${trimmedDataDir}/${serviceName}`);
  }
  for (const hostPath of hostPathsFromManifest(yamlContent)) {
    roots.add(normalizeRoot(hostPath));
  }
  return [...roots];
}

/** Every absolute `spec.volumes[].hostPath.path` in a (possibly multi-doc,
 *  possibly malformed) manifest. Unparseable input yields none. */
function hostPathsFromManifest(yamlContent: string): string[] {
  let docs: unknown[] = [];
  try {
    docs = yaml.loadAll(yamlContent);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const doc of docs) {
    const spec = (doc as { spec?: { volumes?: unknown } } | null)?.spec;
    const volumes = (spec as { volumes?: unknown } | undefined)?.volumes;
    if (!Array.isArray(volumes)) continue;
    for (const v of volumes) {
      const p = (v as { hostPath?: { path?: unknown } } | null)?.hostPath?.path;
      if (typeof p === 'string' && p.startsWith('/')) out.push(p);
    }
  }
  return out;
}

/** True when `filePath` sits at or below one of `roots`. */
export function isWithinRoots(filePath: string, roots: string[]): boolean {
  return roots.some(root => root.length > 0 && (filePath === root || filePath.startsWith(`${root}/`)));
}

/**
 * The extraFile paths that fall outside the service's own scope. Empty array
 * = every path is contained. Callers reject the whole request when non-empty
 * rather than dropping the offending entries — a partial write is worse than
 * a refused deploy.
 */
export function findOutOfScopeExtraFiles(paths: string[], roots: string[]): string[] {
  return paths.filter(p => !isWithinRoots(p, roots));
}
