/**
 * Minimal LLDAP GraphQL client used by features that need to provision
 * users from elsewhere in ServiceBay (e.g. access-request approval,
 * #406). The seed route still has its own inline auth/group helpers
 * because it runs during the wizard before `config.lldap` is
 * populated; this module assumes credentials are already persisted.
 *
 * Returns structured `{ ok, ... }` discriminated unions instead of
 * throwing so callers can render a useful error in the UI without
 * inspecting exception strings.
 */
import { getConfig } from '@/lib/config';

const AUTH_TIMEOUT_MS = 10_000;
const GRAPHQL_TIMEOUT_MS = 10_000;

const CREATE_USER_MUTATION = `
  mutation CreateUser($user: CreateUserInput!) {
    createUser(user: $user) {
      id
      displayName
      email
    }
  }
`;

const LIST_USERS_QUERY = `
  query Users {
    users {
      id
      displayName
      email
    }
  }
`;

// Full directory dump for the config-survival export (#1354): users (with their
// group memberships) + the group list. Passwords are intentionally absent —
// LLDAP uses OPAQUE, so they can't be exported/restored; migrated users set a
// new password on first login.
const EXPORT_DIRECTORY_QUERY = `
  query Directory {
    users { id email displayName groups { displayName } }
    groups { displayName }
  }
`;

interface LldapCredentials {
  url: string;
  username: string;
  password: string;
}

type LldapAuthResult =
  | { ok: true; token: string; baseUrl: string }
  | { ok: false; reason: 'not_configured' | 'unreachable' | 'auth_failed'; message: string };

export type LldapCreateUserResult =
  | { ok: true; userId: string; displayName: string }
  | { ok: false; reason: 'username_taken' | 'graphql_error' | 'network_error'; message: string };

export interface CreateUserInput {
  id: string;
  email: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

function readCredentials(): Promise<LldapCredentials | null> {
  return getConfig().then(config => {
    const lldap = config.lldap;
    if (!lldap?.url || !lldap.password) return null;
    return { url: lldap.url, username: lldap.username || 'admin', password: lldap.password };
  });
}

async function authenticateWithLldap(): Promise<LldapAuthResult> {
  const creds = await readCredentials();
  if (!creds) {
    return { ok: false, reason: 'not_configured', message: 'LLDAP admin credentials are not stored. Open Settings → Integrations to configure LLDAP first.' };
  }
  const baseUrl = creds.url.replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: 'auth_failed', message: `LLDAP rejected the stored credentials (HTTP ${res.status}). Update them in Settings → Integrations.` };
    }
    const data = await res.json().catch(() => ({})) as { token?: string };
    if (!data.token) {
      return { ok: false, reason: 'auth_failed', message: 'LLDAP login response was missing a token.' };
    }
    return { ok: true, token: data.token, baseUrl };
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: e instanceof Error ? e.message : 'Could not reach LLDAP.' };
  }
}

export async function createLldapUser(input: CreateUserInput): Promise<LldapCreateUserResult> {
  const auth = await authenticateWithLldap();
  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason === 'not_configured' || auth.reason === 'unreachable' ? 'network_error' : 'graphql_error',
      message: auth.message,
    };
  }
  try {
    const res = await fetch(`${auth.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        query: CREATE_USER_MUTATION,
        variables: { user: input },
      }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as CreateUserResponse;
    return classifyCreateUserResponse(data, input);
  } catch (e) {
    return { ok: false, reason: 'network_error', message: e instanceof Error ? e.message : 'Network error talking to LLDAP.' };
  }
}

interface CreateUserResponse {
  data?: { createUser?: { id: string; displayName?: string } };
  errors?: Array<{ message?: string }>;
}

/** Map a GraphQL createUser response to the discriminated result. Split out of
 *  createLldapUser to keep that function under the complexity budget. */
function classifyCreateUserResponse(data: CreateUserResponse, input: CreateUserInput): LldapCreateUserResult {
  if (data.errors?.length) {
    const msg = data.errors[0]?.message ?? 'Unknown LLDAP error.';
    const lower = msg.toLowerCase();
    // A duplicate surfaces either as LLDAP's friendly "already exists"/"duplicate"
    // text or as the raw SQLite UNIQUE-constraint error (e.g.
    // "UNIQUE constraint failed: users.lowercase_email") — map both to a coherent
    // "already in use" outcome so the raw DB error never reaches the operator (#1425).
    if (lower.includes('already exists') || lower.includes('duplicate') || lower.includes('unique constraint')) {
      const byEmail = lower.includes('email');
      return {
        ok: false,
        reason: 'username_taken',
        message: byEmail
          ? `A user with the email "${input.email}" already exists in LLDAP.`
          : `The username "${input.id}" is already in use in LLDAP.`,
      };
    }
    return { ok: false, reason: 'graphql_error', message: msg };
  }
  const created = data.data?.createUser;
  if (!created) {
    return { ok: false, reason: 'graphql_error', message: 'LLDAP response did not include the created user.' };
  }
  return { ok: true, userId: created.id, displayName: created.displayName ?? input.displayName ?? input.id };
}

export interface LldapUser {
  id: string;
  displayName?: string;
  email?: string;
}

export type LldapListUsersResult =
  | { ok: true; users: LldapUser[] }
  | { ok: false; reason: 'not_configured' | 'unreachable' | 'auth_failed' | 'graphql_error' | 'network_error'; message: string };

/**
 * List all LLDAP users. Used by the file-share template's Samba sync
 * (#494) to mirror per-user accounts into Samba's tdbsam DB, and by
 * future SSO-aware features that need to enumerate the identity
 * directory.
 *
 * Returns the same `{ ok, ... }` discriminated union shape as
 * `createLldapUser` so callers stay uniform.
 */
export async function listLldapUsers(): Promise<LldapListUsersResult> {
  const auth = await authenticateWithLldap();
  if (!auth.ok) {
    return { ok: false, reason: auth.reason, message: auth.message };
  }
  try {
    const res = await fetch(`${auth.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ query: LIST_USERS_QUERY }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as {
      data?: { users?: LldapUser[] };
      errors?: Array<{ message?: string }>;
    };
    if (data.errors?.length) {
      return { ok: false, reason: 'graphql_error', message: data.errors[0]?.message ?? 'Unknown LLDAP error.' };
    }
    return { ok: true, users: data.data?.users ?? [] };
  } catch (e) {
    return { ok: false, reason: 'network_error', message: e instanceof Error ? e.message : 'Network error talking to LLDAP.' };
  }
}

/** One exported user — group memberships by displayName; no password (OPAQUE). */
export interface LldapDirectoryUser {
  id: string;
  email?: string;
  displayName?: string;
  groups: string[];
}

/** A point-in-time dump of the LLDAP directory for config-survival (#1354). */
export interface LldapDirectory {
  exportedAt: string;
  groups: string[];
  users: LldapDirectoryUser[];
}

export type LldapExportResult =
  | { ok: true; directory: LldapDirectory }
  | { ok: false; reason: 'not_configured' | 'unreachable' | 'auth_failed' | 'graphql_error' | 'network_error'; message: string };

/**
 * Export the full LLDAP directory — every user (with their group memberships)
 * plus the group list — for staging onto the NAS so a fresh install can re-seed
 * the same accounts (#1354). Passwords are NOT included (LLDAP uses OPAQUE, so
 * they can't leave over GraphQL); migrated users set a new password on first
 * login. Reuses the same auth + GraphQL path as the other client calls.
 */
export async function exportLldapDirectory(): Promise<LldapExportResult> {
  const auth = await authenticateWithLldap();
  if (!auth.ok) {
    return { ok: false, reason: auth.reason, message: auth.message };
  }
  try {
    const res = await fetch(`${auth.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ query: EXPORT_DIRECTORY_QUERY }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({})) as {
      data?: { users?: Array<{ id: string; email?: string; displayName?: string; groups?: Array<{ displayName: string }> }>; groups?: Array<{ displayName: string }> };
      errors?: Array<{ message?: string }>;
    };
    if (data.errors?.length) {
      return { ok: false, reason: 'graphql_error', message: data.errors[0]?.message ?? 'Unknown LLDAP error.' };
    }
    const users: LldapDirectoryUser[] = (data.data?.users ?? []).map(u => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      groups: (u.groups ?? []).map(g => g.displayName),
    }));
    const groups = (data.data?.groups ?? []).map(g => g.displayName);
    return { ok: true, directory: { exportedAt: new Date().toISOString(), groups, users } };
  } catch (e) {
    return { ok: false, reason: 'network_error', message: e instanceof Error ? e.message : 'Network error talking to LLDAP.' };
  }
}

// ---------------------------------------------------------------------------
// Group + lifecycle primitives used by the SSO verification module (#1453).
// These mirror the GraphQL calls scripts/smoke/sso-verify.sh makes against the
// admin token, but in-process: list the groups (so a caller can resolve the
// `family`/`admins` group ids Authelia's rules key off), add a user to a
// group, and delete a user (the smoke test's guaranteed teardown). Same
// `{ ok, ... }` discriminated-union shape as the rest of the client.
// ---------------------------------------------------------------------------

const LIST_GROUPS_QUERY = `
  query Groups {
    groups { id displayName }
  }
`;

const ADD_USER_TO_GROUP_MUTATION = `
  mutation AddUserToGroup($userId: String!, $groupId: Int!) {
    addUserToGroup(userId: $userId, groupId: $groupId) { ok }
  }
`;

const DELETE_USER_MUTATION = `
  mutation DeleteUser($userId: String!) {
    deleteUser(userId: $userId) { ok }
  }
`;

type LldapMutationReason =
  | 'not_configured'
  | 'unreachable'
  | 'auth_failed'
  | 'graphql_error'
  | 'network_error';

/** Run an authenticated GraphQL request against LLDAP, returning the parsed
 *  `data`/`errors` body or a discriminated failure. Centralises the auth +
 *  fetch + error-mapping boilerplate the group/lifecycle calls share. */
async function runAuthedGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; reason: LldapMutationReason; message: string }> {
  const auth = await authenticateWithLldap();
  if (!auth.ok) return { ok: false, reason: auth.reason, message: auth.message };
  try {
    const res = await fetch(`${auth.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      return { ok: false, reason: 'graphql_error', message: body.errors[0]?.message ?? 'Unknown LLDAP error.' };
    }
    if (body.data === undefined) {
      return { ok: false, reason: 'graphql_error', message: 'LLDAP response had no data.' };
    }
    return { ok: true, data: body.data };
  } catch (e) {
    return { ok: false, reason: 'network_error', message: e instanceof Error ? e.message : 'Network error talking to LLDAP.' };
  }
}

export interface LldapGroup {
  id: number;
  displayName: string;
}

export type LldapListGroupsResult =
  | { ok: true; groups: LldapGroup[] }
  | { ok: false; reason: LldapMutationReason; message: string };

/** List every LLDAP group (id + displayName). Lets a caller resolve the
 *  numeric group id for `family` / `admins` — Authelia's access rules key
 *  off membership in those, and `addUserToGroup` takes the numeric id. */
export async function listLldapGroups(): Promise<LldapListGroupsResult> {
  const r = await runAuthedGraphql<{ groups?: LldapGroup[] }>(LIST_GROUPS_QUERY);
  if (!r.ok) return r;
  return { ok: true, groups: r.data.groups ?? [] };
}

export type LldapMutationResult =
  | { ok: true }
  | { ok: false; reason: LldapMutationReason; message: string };

/** Add an existing user to a group by numeric group id. */
export async function addUserToLldapGroup(userId: string, groupId: number): Promise<LldapMutationResult> {
  const r = await runAuthedGraphql<{ addUserToGroup?: { ok?: boolean } }>(
    ADD_USER_TO_GROUP_MUTATION,
    { userId, groupId },
  );
  if (!r.ok) return r;
  if (r.data.addUserToGroup?.ok !== true) {
    return { ok: false, reason: 'graphql_error', message: `LLDAP did not confirm adding ${userId} to group ${groupId}.` };
  }
  return { ok: true };
}

/** Delete an LLDAP user by id. Used as the SSO-verify module's guaranteed
 *  ephemeral-user teardown — safe to call even if the user was never fully
 *  provisioned (a missing user surfaces as a graphql_error the caller can
 *  treat as already-gone). */
export async function deleteLldapUser(userId: string): Promise<LldapMutationResult> {
  const r = await runAuthedGraphql<{ deleteUser?: { ok?: boolean } }>(
    DELETE_USER_MUTATION,
    { userId },
  );
  if (!r.ok) return r;
  if (r.data.deleteUser?.ok !== true) {
    return { ok: false, reason: 'graphql_error', message: `LLDAP did not confirm deletion of ${userId}.` };
  }
  return { ok: true };
}

/**
 * LLDAP's web UI URL for a specific user's detail page — used as the
 * deep-link target after auto-create so the admin lands directly on
 * the group-assignment view.
 *
 * Prefers the NPM-exposed subdomain stored under `reverseProxy.hosts`
 * (same source as `/api/auth/lldap-url`, used by the sidebar) over
 * `config.lldap.url`. The latter is the server-internal URL —
 * `http://localhost:17170` — which is what `templates/auth/post-deploy.py`
 * writes for in-process API calls and is unreachable from the admin's
 * browser (#442). Falls back to `config.lldap.url` for LAN-only installs
 * with no NPM entry, where localhost may at least work for an admin
 * browsing from the server itself.
 *
 * **Discriminator: forwardPort, not service name.** LLDAP_SUBDOMAIN
 * lives in the `auth` template alongside AUTHELIA_SUBDOMAIN, so the
 * installer's `buildProxyHosts` writes `service: 'auth'` on both
 * hosts (`templateName` from `useStackInstall` populates that field;
 * see `lib/stackInstall/postInstall.ts`). Matching on
 * `service === 'lldap'` silently fails and the deep-link falls
 * through to the localhost URL — what the operator reported when
 * the approval flow opened a tab pointing at `http://localhost:17170/user/<id>`
 * instead of `https://ldap.<domain>/user/<id>`. We discriminate by
 * port instead: parse LLDAP_PORT out of `config.lldap.url` (always
 * `http://localhost:<LLDAP_PORT>`) and find the host whose
 * `forwardPort` matches. Falls back to the legacy `service === 'lldap'`
 * match for any older install where the field happens to carry that
 * literal value.
 *
 * Scheme: NPM serves subdomains under `publicDomain` via its
 * wildcard Let's Encrypt cert — HTTPS works whether the entry is
 * tagged `public` or `lan`. Pure `.home.arpa` / `.local` domains
 * have no cert; fall back to HTTP for those so the link actually
 * loads.
 */
export async function getLldapUserDeepLink(userId: string): Promise<string | null> {
  const config = await getConfig();
  const lldapUrl = config.lldap?.url;
  let lldapPort: number | null = null;
  if (lldapUrl) {
    try {
      const parsedPort = Number(new URL(lldapUrl).port);
      if (Number.isFinite(parsedPort) && parsedPort > 0) lldapPort = parsedPort;
    } catch {
      // malformed URL — ignore, fall through to service-name match
    }
  }
  const hosts = config.reverseProxy?.hosts ?? [];
  const proxied = hosts.find(h =>
    h.created && (
      (lldapPort !== null && h.forwardPort === lldapPort)
      || h.service === 'lldap'
    ),
  );
  let base: string | undefined;
  if (proxied) {
    const isPureLanDomain = /\.(home\.arpa|local)$/i.test(proxied.domain);
    base = `${isPureLanDomain ? 'http' : 'https'}://${proxied.domain}`;
  } else {
    base = lldapUrl;
  }
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/user/${encodeURIComponent(userId)}`;
}
