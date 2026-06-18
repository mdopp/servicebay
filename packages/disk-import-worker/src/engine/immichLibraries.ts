// disk-import-worker — Immich External-Library provisioning + scan (#1954,
// Decision A). Ported from the deleted backend `diskImport/immichLibraries.ts`
// (removed in the #1953 rip) into the worker, where `--apply` now runs.
//
// Keyless per-user photos: the importer COPIES photos into `data/<owner>/photos`
// (or the shared `data/photos`) like every other category, and Immich indexes
// them via per-user EXTERNAL LIBRARIES over a read-only mount of those folders
// into immich-server. This module is the admin-side glue: using ONE Immich ADMIN
// API key (never per-user keys, never asking users) it auto-provisions one
// external library per box user plus a shared "Shared" library, then triggers
// the owning library's scan after a photo-writing apply.
//
//   box user `u`  → library "<u>",   import path `<MOUNT>/<u>/photos`
//   shared        → library "Shared", import path `<MOUNT>/photos`
//
// Unlike the old backend module, this one takes NO backend dependency: the box
// user list and the resolved admin config (server URL + admin key) are passed
// IN by the worker entrypoint (sourced from launcher-injected env). The control
// plane still owns the encrypted secret store + the LLDAP directory + the
// reconcile/mint of the key; the worker only does the read-only HTTP CRUD here.
//
// NO upload, NO active push: external libraries reference files in place
// (read-only in Immich, accepted per Decision A — no double storage). The only
// API calls here are admin CRUD on libraries + a scan trigger.

/** Where the photo areas are mounted READ-ONLY inside immich-server (template). */
export const IMMICH_EXTERNAL_MOUNT = '/mnt/photos';

/** The shared library's display name (and the shared import sub-path's owner). */
export const SHARED_LIBRARY_NAME = 'Shared';

const REQUEST_TIMEOUT_MS = 15_000;

/** Config for talking to the Immich admin API with the single stored key. */
export interface ImmichAdminConfig {
  /** Immich server base URL, e.g. `http://127.0.0.1:2283`. No trailing slash. */
  serverUrl: string;
  /** The SINGLE Immich ADMIN API key (x-api-key). Not a per-user key. */
  adminApiKey: string;
}

/** A box user the importer routes photos for (LLDAP id + optional email). */
export interface BoxUser {
  id: string;
  email?: string;
}

/** An Immich user as returned by the admin `GET /api/users`. */
interface ImmichUser {
  id: string;
  email?: string;
  name?: string;
}

/** An Immich external library as returned by `GET /api/libraries`. */
interface ImmichLibrary {
  id: string;
  ownerId: string;
  name: string;
  importPaths?: string[];
}

/** The import path inside the container for a box user's private photos. */
export function userImportPath(userId: string): string {
  return `${IMMICH_EXTERNAL_MOUNT}/${userId}/photos`;
}

/** The import path inside the container for the shared photos area. */
export function sharedImportPath(): string {
  return `${IMMICH_EXTERNAL_MOUNT}/photos`;
}

/** Result of a provisioning pass: which libraries exist after it ran. */
export interface ProvisionResult {
  /** Library id keyed by box-user id (`shared` key → the Shared library). */
  libraryIdByOwner: Map<string, string>;
  /** Box users with no matching Immich account (no private library created). */
  unmatchedUsers: string[];
}

async function immichFetch(
  cfg: ImmichAdminConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-api-key': cfg.adminApiKey,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function assertOk(status: number, what: string): void {
  if (status < 200 || status >= 300) {
    throw new Error(`disk-import/immich: ${what} failed (HTTP ${status})`);
  }
}

/** List the Immich accounts visible to the admin key. */
async function listImmichUsers(cfg: ImmichAdminConfig): Promise<ImmichUser[]> {
  const { status, json } = await immichFetch(cfg, 'GET', '/api/users');
  assertOk(status, 'list users');
  return Array.isArray(json) ? (json as ImmichUser[]) : [];
}

/** The admin's own account id (owner of the Shared library). */
async function adminUserId(cfg: ImmichAdminConfig): Promise<string> {
  const { status, json } = await immichFetch(cfg, 'GET', '/api/users/me');
  assertOk(status, 'fetch admin identity');
  const id = (json as ImmichUser | null)?.id;
  if (!id) throw new Error('disk-import/immich: admin identity has no id');
  return id;
}

/** List existing external libraries. */
async function listLibraries(cfg: ImmichAdminConfig): Promise<ImmichLibrary[]> {
  const { status, json } = await immichFetch(cfg, 'GET', '/api/libraries');
  assertOk(status, 'list libraries');
  return Array.isArray(json) ? (json as ImmichLibrary[]) : [];
}

/**
 * Create an external library owned by `ownerId` with one import path. Idempotent
 * at the caller (we only create when no library with the same name+owner+path
 * already exists), so this is a plain create.
 */
async function createLibrary(
  cfg: ImmichAdminConfig,
  ownerId: string,
  name: string,
  importPath: string,
): Promise<string> {
  const { status, json } = await immichFetch(cfg, 'POST', '/api/libraries', {
    ownerId,
    name,
    importPaths: [importPath],
    exclusionPatterns: [],
  });
  assertOk(status, `create library "${name}"`);
  const id = (json as ImmichLibrary | null)?.id;
  if (!id) throw new Error(`disk-import/immich: created library "${name}" has no id`);
  return id;
}

/** Match a box user (id/email from LLDAP) to an Immich account. */
function matchImmichUser(
  boxUserId: string,
  boxUserEmail: string | undefined,
  immichUsers: ImmichUser[],
): ImmichUser | undefined {
  const wantEmail = boxUserEmail?.toLowerCase();
  return immichUsers.find(u => {
    if (wantEmail && u.email?.toLowerCase() === wantEmail) return true;
    return u.name?.toLowerCase() === boxUserId.toLowerCase();
  });
}

/**
 * Decide whether an existing library already covers `name`+`ownerId`+`importPath`
 * (so we don't create a duplicate on re-run / reinstall).
 */
function libraryExists(
  libs: ImmichLibrary[],
  ownerId: string,
  name: string,
  importPath: string,
): ImmichLibrary | undefined {
  return libs.find(
    l =>
      l.ownerId === ownerId &&
      l.name === name &&
      (l.importPaths ?? []).includes(importPath),
  );
}

/**
 * Auto-provision the external libraries for the box (Decision A). Idempotent:
 * re-runs reuse libraries that already match. Box users are passed in by the
 * worker entrypoint (the launcher-injected list, sourced from the same LLDAP
 * directory the routing-tree owner axis uses); the Shared library is owned by
 * the admin key's user. Returns the library-id map (keyed by box-user id, plus
 * `shared`) and any box users with no Immich account yet.
 */
export async function provisionExternalLibraries(
  cfg: ImmichAdminConfig,
  boxUsers: readonly BoxUser[],
): Promise<ProvisionResult> {
  const [immichUsers, existing, admin] = await Promise.all([
    listImmichUsers(cfg),
    listLibraries(cfg),
    adminUserId(cfg),
  ]);

  const libraryIdByOwner = new Map<string, string>();
  const unmatchedUsers: string[] = [];

  // Shared library — owned by the admin, import path = `<MOUNT>/photos`.
  const sharedPath = sharedImportPath();
  const sharedHit = libraryExists(existing, admin, SHARED_LIBRARY_NAME, sharedPath);
  libraryIdByOwner.set(
    'shared',
    sharedHit ? sharedHit.id : await createLibrary(cfg, admin, SHARED_LIBRARY_NAME, sharedPath),
  );

  // One private library per box user, owned by that user's Immich account.
  for (const boxUser of boxUsers) {
    const immichUser = matchImmichUser(boxUser.id, boxUser.email, immichUsers);
    if (!immichUser) {
      unmatchedUsers.push(boxUser.id);
      continue;
    }
    const path = userImportPath(boxUser.id);
    const hit = libraryExists(existing, immichUser.id, boxUser.id, path);
    libraryIdByOwner.set(
      boxUser.id,
      hit ? hit.id : await createLibrary(cfg, immichUser.id, boxUser.id, path),
    );
  }

  return { libraryIdByOwner, unmatchedUsers };
}

/** Trigger an external-library refresh scan via the admin API. */
export async function scanLibrary(cfg: ImmichAdminConfig, libraryId: string): Promise<void> {
  const { status } = await immichFetch(cfg, 'POST', `/api/libraries/${libraryId}/scan`);
  assertOk(status, `scan library ${libraryId}`);
}

/**
 * After a disk apply that wrote photos, trigger the owning libraries' scans so
 * Immich picks the new files up. `owners` are the destination-area owner keys
 * the photo plan wrote to (`shared` for the shared area, a box-user id for a
 * private area). Unknown/unprovisioned owners are skipped silently — the files
 * are on disk and a later full provision+scan will still find them.
 */
export async function scanLibrariesForOwners(
  cfg: ImmichAdminConfig,
  libraryIdByOwner: ReadonlyMap<string, string>,
  owners: Iterable<string>,
): Promise<void> {
  const seen = new Set<string>();
  for (const owner of owners) {
    const libraryId = libraryIdByOwner.get(owner);
    if (!libraryId || seen.has(libraryId)) continue;
    seen.add(libraryId);
    await scanLibrary(cfg, libraryId);
  }
}

/**
 * Resolve the worker's Immich provisioning inputs from the launcher-injected
 * env, or `null` when Immich provisioning isn't wired (so the apply path just
 * places photos in the folder and skips the scan — a graceful no-op when Immich
 * isn't installed). The control plane resolves the admin key + box-user list and
 * injects them; the worker never logs or persists the key.
 *
 *   IMMICH_SERVER_URL      e.g. http://127.0.0.1:2283  (no trailing slash)
 *   IMMICH_ADMIN_API_KEY   the single stored admin x-api-key
 *   DISK_IMPORT_BOX_USERS  JSON `[{ "id": "...", "email": "..." }, …]`
 */
export function immichProvisionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { cfg: ImmichAdminConfig; boxUsers: BoxUser[] } | null {
  const serverUrl = (env.IMMICH_SERVER_URL ?? '').replace(/\/+$/, '');
  const adminApiKey = env.IMMICH_ADMIN_API_KEY ?? '';
  if (!serverUrl || !adminApiKey) return null;

  let boxUsers: BoxUser[] = [];
  const raw = env.DISK_IMPORT_BOX_USERS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        boxUsers = parsed
          .filter((u): u is { id: unknown; email?: unknown } => !!u && typeof u === 'object' && 'id' in u)
          .filter(u => typeof u.id === 'string' && u.id.length > 0)
          .map(u => ({ id: String(u.id), email: typeof u.email === 'string' ? u.email : undefined }));
      }
    } catch {
      // Malformed list → provision only the Shared library (private libs skipped).
      boxUsers = [];
    }
  }

  return { cfg: { serverUrl, adminApiKey }, boxUsers };
}
