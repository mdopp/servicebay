// Disk-import — Immich External-Library provisioning (#1904, Decision A).
//
// Keyless per-user photos: instead of CLI-uploading with one API key per user,
// the disk importer just COPIES photos into `data/<owner>/photos` (or the
// shared `data/photos`) like every other category (#1914 place-in-folder), and
// Immich indexes them via per-user EXTERNAL LIBRARIES over a read-only mount of
// those folders into immich-server (the immich template).
//
// This module is the admin-side glue: using ONE stored Immich ADMIN API key
// (never per-user keys, never asking users), it auto-provisions one external
// library per box user plus a shared "Shared" library, then triggers the
// owning library's scan after a photo-writing import.
//
//   box user `u`  → library "<u>",   import path `<MOUNT>/<u>/photos`
//   shared        → library "Shared", import path `<MOUNT>/photos`
//
// The box-user list is the SAME source #1912 uses for the routing-tree owner
// axis — `listLldapUsers()` — so the importer's owners and Immich's libraries
// stay in lock-step. Immich users are matched to box users by id/email; the
// shared library is owned by the admin (the API key's user).
//
// NO upload, NO active push: external libraries reference files in place
// (read-only in Immich, accepted per Decision A — no double storage). The only
// API calls here are admin CRUD on libraries + a scan trigger.

import { getConfig } from '@/lib/config';
import { loadSavedSecrets } from '@/lib/install/savedSecrets';
import { listLldapUsers } from '@/lib/lldap/client';

import { IMMICH_ADMIN_API_KEY_VAR, reconcileImmichApiKey } from './reconcileImmichApiKey';

/** Where the photo areas are mounted READ-ONLY inside immich-server (template). */
export const IMMICH_EXTERNAL_MOUNT = '/mnt/photos';

/** The shared library's display name (and the shared import sub-path's owner). */
export const SHARED_LIBRARY_NAME = 'Shared';

const REQUEST_TIMEOUT_MS = 15_000;

/** Config for talking to the Immich admin API with the single stored key. */
export interface ImmichAdminConfig {
  /** Immich server base URL, e.g. `http://127.0.0.1:2283`. No trailing slash. */
  serverUrl: string;
  /** The SINGLE stored Immich ADMIN API key (x-api-key). Not a per-user key. */
  adminApiKey: string;
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
 * re-runs reuse libraries that already match. Box users come from
 * `listLldapUsers()` (the #1912 owner-axis source); the Shared library is owned
 * by the admin key's user. Returns the library-id map (keyed by box-user id,
 * plus `shared`) and any box users with no Immich account yet.
 */
export async function provisionExternalLibraries(
  cfg: ImmichAdminConfig,
): Promise<ProvisionResult> {
  const usersResult = await listLldapUsers();
  if (!usersResult.ok) {
    throw new Error(
      `disk-import/immich: cannot enumerate box users for library provisioning: ${usersResult.message}`,
    );
  }

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
  for (const boxUser of usersResult.users) {
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

/**
 * Resolve the Immich admin-API config for the disk-import apply path: ensure a
 * single admin API key is stored (mint-on-demand via {@link reconcileImmichApiKey},
 * idempotent) and return `{ serverUrl, adminApiKey }`. Returns `null` when no key
 * could be obtained (Immich not installed, admin login rejected) — the importer
 * then just places photos in the folder and skips the scan. Never logs the key.
 *
 * @param serverUrl Immich loopback URL, e.g. `http://127.0.0.1:2283`.
 */
export async function resolveImmichAdminConfig(
  serverUrl: string,
): Promise<ImmichAdminConfig | null> {
  await reconcileImmichApiKey(serverUrl);
  const adminApiKey = loadSavedSecrets(await getConfig())[IMMICH_ADMIN_API_KEY_VAR];
  if (!adminApiKey) return null;
  return { serverUrl, adminApiKey };
}

/** Trigger an external-library refresh scan via the admin API. */
export async function scanLibrary(cfg: ImmichAdminConfig, libraryId: string): Promise<void> {
  const { status } = await immichFetch(cfg, 'POST', `/api/libraries/${libraryId}/scan`);
  assertOk(status, `scan library ${libraryId}`);
}

/**
 * After a disk import that wrote photos, trigger the owning libraries' scans so
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
