// Resolve the HOST path of servicebay's data dir, at launch time.
//
// Why this exists: the disk-import worker is launched with `podman run` over the
// MOUNTED podman socket, so podman runs on the HOST. The `-v <src>:/out` bind
// mount SOURCE must therefore be a HOST path. servicebay's own `/app/data` is the
// in-container view (read-only on the host); the host path is `/mnt/data/servicebay`.
//
// Previously this came only from the HOST_DATA_DIR env var (set by the quadlet).
// Boxes installed before that env var was added fall back to `/app/data` → the
// worker's `mkdir`/bind-mount fails (EROFS) and `podman run` exits 125. A startup
// "quadlet self-heal" was attempted but is architecturally impossible: the
// servicebay container cannot edit the host quadlet (it isn't mounted in).
//
// Instead we resolve the host path at LAUNCH time, with no restart and no quadlet
// edits — reinstall-proof:
//   a. HOST_DATA_DIR env if set & non-empty;
//   b. else inspect servicebay's OWN container via the already-mounted podman
//      socket and read the Mount whose Destination is /app/data → its Source
//      (the real host path);
//   c. else the conventional default (HOST_DATA_DIR's fallback in dirs.ts).

import type { SafeExec } from '@servicebay/disk-import-worker';
import { HOST_DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';

/** servicebay's own container (ContainerName=servicebay in the quadlet). */
const SERVICEBAY_CONTAINER = 'servicebay';

/** The in-container destination of servicebay's data volume (quadlet Volume=). */
const DATA_DEST = '/app/data';

interface InspectMount {
  Destination?: string;
  Source?: string;
}

/**
 * Resolve the HOST path of servicebay's data dir. Priority:
 *   a. process.env.HOST_DATA_DIR (set & non-empty);
 *   b. `podman container inspect servicebay` → Mount with Destination /app/data → Source;
 *   c. the conventional default (`HOST_DATA_DIR` from dirs.ts, which is /mnt/data/servicebay
 *      unless overridden — also the dev/test value where host == container).
 *
 * Any inspect error (no socket, container not found, malformed JSON, no matching
 * mount) falls through to the default with a warning — never throws.
 */
export async function resolveHostDataDir(exec: SafeExec): Promise<string> {
  // a. Explicit env wins (the quadlet sets this on freshly-installed boxes).
  const fromEnv = process.env.HOST_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  // b. Ask podman (over the mounted socket) where servicebay's /app/data lives
  //    on the host. This is the reinstall-proof path for boxes whose quadlet
  //    predates the HOST_DATA_DIR env var.
  try {
    const { stdout, code } = await exec([
      'podman', 'container', 'inspect', SERVICEBAY_CONTAINER, '--format', 'json',
    ]);
    if (code === 0 && stdout.trim()) {
      const source = parseDataMountSource(stdout);
      if (source) return source;
      logger.warn(
        'DiskImport',
        `resolveHostDataDir: no mount with Destination ${DATA_DEST} in '${SERVICEBAY_CONTAINER}' inspect — using default ${HOST_DATA_DIR}`,
      );
    } else {
      logger.warn(
        'DiskImport',
        `resolveHostDataDir: \`podman container inspect ${SERVICEBAY_CONTAINER}\` exited ${code} — using default ${HOST_DATA_DIR}`,
      );
    }
  } catch (e) {
    logger.warn('DiskImport', `resolveHostDataDir: podman inspect failed — using default ${HOST_DATA_DIR}`, e);
  }

  // c. Conventional default (also the dev/test host == container value).
  return HOST_DATA_DIR;
}

/**
 * From `podman container inspect ... --format json` output, return the host
 * Source of the Mount whose Destination is /app/data, or null. Tolerates both
 * the array form (`inspect` returns `[ {...} ]`) and a bare object.
 */
function parseDataMountSource(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const containers = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of containers) {
    const mounts = (c as { Mounts?: InspectMount[] })?.Mounts;
    if (!Array.isArray(mounts)) continue;
    const dataMount = mounts.find(m => m?.Destination === DATA_DEST);
    if (dataMount?.Source && dataMount.Source.trim().length > 0) {
      return dataMount.Source;
    }
  }
  return null;
}
