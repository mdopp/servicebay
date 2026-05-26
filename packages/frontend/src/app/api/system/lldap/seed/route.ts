import { NextResponse } from 'next/server';

import { withApiHandler } from '@/lib/api/handler';
export const dynamic = 'force-dynamic';

const LLDAP_GRAPHQL_GROUPS = `
  mutation CreateGroup($name: String!) {
    createGroup(name: $name) {
      id
      displayName
    }
  }
`;

const LLDAP_GRAPHQL_LIST_GROUPS = `
  { groups { id displayName } }
`;

const LLDAP_GRAPHQL_ADD_USER_TO_GROUP = `
  mutation AddUserToGroup($userId: String!, $groupId: Int!) {
    addUserToGroup(userId: $userId, groupId: $groupId) { ok }
  }
`;

const LLDAP_GRAPHQL_USER_GROUPS = `
  query UserGroups($userId: String!) {
    user(userId: $userId) { groups { id displayName } }
  }
`;

const LLDAP_GRAPHQL_CREATE_USER = `
  mutation CreateUser($user: CreateUserInput!) {
    createUser(user: $user) { id displayName email }
  }
`;

interface SeedRequest {
  host?: string;
  port?: number;
  password: string;
  groups?: string[];
  /** Optional operator-user spec (#988). When provided, the seed route
   *  also creates this LLDAP user and adds them to `admins` so the
   *  operator skips the "log in to LLDAP as admin, find your user,
   *  add to admins" catch-22 on first run. The password must be set
   *  separately via the LLDAP UI — LLDAP uses OPAQUE, so passwords
   *  can't be set over GraphQL. */
  operator?: {
    uid: string;
    email: string;
    displayName?: string;
  };
}

const DEFAULT_GROUPS = ['admins', 'family'];

/** Quick reachability check: LLDAP returns 401 on /api/graphql once the API
 *  layer + DB are up. Caller is the wizard which has already polled for
 *  readiness — we only re-probe with a short timeout to fail fast. */
async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 401 || res.ok;
  } catch {
    return false;
  }
}

/** Authenticate with LLDAP and get a JWT token. Returns the token on success,
 *  or a structured error indicating why authentication failed. */
type AuthResult = { ok: true; token: string } | { ok: false; status: number; reason: string };

async function authenticate(baseUrl: string, password: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${baseUrl}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `LLDAP returned HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!data.token) return { ok: false, status: res.status, reason: 'LLDAP login response missing token' };
    return { ok: true, token: data.token };
  } catch (e) {
    return { ok: false, status: 0, reason: e instanceof Error ? e.message : 'connection failed' };
  }
}

/** Create a group via LLDAP GraphQL API. Returns group name or null on failure. */
async function createGroup(baseUrl: string, token: string, groupName: string): Promise<{ name: string; created: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: LLDAP_GRAPHQL_GROUPS,
        variables: { name: groupName },
      }),
    });
    const data = await res.json();
    if (data.errors?.length) {
      const msg = data.errors[0].message || '';
      const lowerMsg = msg.toLowerCase();
      // "already exists" is fine
      if (
        lowerMsg.includes('already exists') ||
        lowerMsg.includes('duplicate') ||
        lowerMsg.includes('unique constraint')
      ) {
        return { name: groupName, created: false };
      }
      return { name: groupName, created: false, error: msg };
    }
    return { name: groupName, created: true };
  } catch (e) {
    return { name: groupName, created: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/** Seed LLDAP with default groups after installation. */
export const POST = withApiHandler({}, async ({ request }) => {
  const body = await request.json() as SeedRequest;
  const host = body.host || 'localhost';
  const port = body.port || 17170;
  const password = body.password;
  const groups = body.groups || DEFAULT_GROUPS;

  if (!password) {
    return NextResponse.json({ error: 'Missing LLDAP admin password' }, { status: 400 });
  }

  const baseUrl = `http://${host}:${port}`;

  // Quick re-probe — wizard already waited for readiness, so this is mostly a
  // belt-and-suspenders check that we're talking to the right thing.
  if (!(await isReachable(baseUrl))) {
    return NextResponse.json({ error: 'LLDAP not reachable — it may still be starting up' }, { status: 503 });
  }

  const auth = await authenticate(baseUrl, password);
  if (!auth.ok) {
    if (auth.status === 401 || auth.status === 403) {
      // Most common root cause: the data volume from a previous install still
      // holds the old admin password, so the new env LLDAP_LDAP_USER_PASS was
      // ignored. Surface that explicitly so the user knows to wipe the volume.
      return NextResponse.json({
        error: 'LLDAP rejected the admin password. This usually means an existing LLDAP data volume from a previous install still holds the old password — LLDAP_LDAP_USER_PASS only takes effect on first DB initialization. Fix on the default Fedora CoreOS layout:\n\n  ssh core@<server>\n  systemctl --user stop auth.service\n  # podman unshare is required because users.db is owned by LLDAP\'s\n  # in-container UID (~525287), so a plain `rm` fails with EPERM.\n  podman unshare rm -f /var/mnt/data/stacks/auth/lldap/users.db\n  # If Authelia also fails with "encryption key not valid":\n  podman unshare rm -f /var/mnt/data/stacks/auth/authelia-data/db.sqlite3\n  systemctl --user start auth.service\n\nThen re-add LLDAP users at http://<server>:17170 (admin password is the one ServiceBay generated this install — see Settings → Integrations → Saved credentials). Alternative if you remember the previous install\'s LLDAP admin password: set it on `config.auth.lldap.password` in Settings → Integrations → LLDAP, no wipe needed.',
        reason: 'auth_rejected',
      }, { status: 401 });
    }
    return NextResponse.json({ error: `Could not authenticate with LLDAP: ${auth.reason}`, reason: 'auth_failed' }, { status: 502 });
  }

  const results = await Promise.all(groups.map(g => createGroup(baseUrl, auth.token, g)));
  const created = results.filter(r => r.created).map(r => r.name);
  const existing = results.filter(r => !r.created && !r.error).map(r => r.name);
  const failed = results.filter(r => r.error).map(r => ({ name: r.name, error: r.error }));

  // Auto-grant LLDAP's built-in `admin` user the `admins` group so
  // the operator can immediately reach https://ldap.<domain>/ via
  // Authelia's admin-domain rule (`subject: group:admins`). Without
  // this step the docs' first-run path (per project memory:
  // *"log in as admin to LLDAP and add users to family"*) hit
  // Authelia 403 on every protected admin domain — the LLDAP admin
  // is in `lldap_admin` by default, not the Authelia `admins` group.
  // Best-effort: a failure here doesn't fail the seed.
  let adminGrant: { ok: boolean; reason?: string } = { ok: false };
  if (groups.includes('admins') && !failed.some(f => f.name === 'admins')) {
    adminGrant = await grantAdminGroup(baseUrl, auth.token);
  }

  // #988 — auto-provision the operator user in `admins` so the operator
  // can reach every protected domain on first login. Without this they
  // hit a catch-22: the LLDAP UI (where they'd add themselves to
  // admins) is itself behind the admin-only Authelia rule. Best-effort:
  // a failure here is logged but doesn't fail the seed.
  let operatorProvision: { ok: boolean; uid?: string; created?: boolean; reason?: string } = { ok: false };
  if (body.operator?.uid && body.operator?.email) {
    operatorProvision = await provisionOperatorUser(baseUrl, auth.token, body.operator);
  }

  return NextResponse.json({ created, existing, failed, adminGrant, operatorProvision });
});

/**
 * Add LLDAP's built-in `admin` user to the `admins` group (idempotent).
 * Lookups the group id off the live group list rather than capturing
 * it from the createGroup response so the call works equally well
 * when the group already exists from a previous install.
 */
async function grantAdminGroup(baseUrl: string, token: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    // 1) Already a member? Short-circuit so we don't post a useless mutation.
    const memberRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: LLDAP_GRAPHQL_USER_GROUPS, variables: { userId: 'admin' } }),
      signal: AbortSignal.timeout(5000),
    });
    if (memberRes.ok) {
      const data = await memberRes.json();
      const groupsForAdmin: Array<{ displayName?: string }> = data?.data?.user?.groups ?? [];
      if (groupsForAdmin.some(g => g.displayName === 'admins')) {
        return { ok: true };
      }
    }

    // 2) Resolve `admins` group id off the live listing.
    const listRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: LLDAP_GRAPHQL_LIST_GROUPS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!listRes.ok) return { ok: false, reason: `groups query HTTP ${listRes.status}` };
    const listData = await listRes.json();
    const allGroups: Array<{ id: number; displayName: string }> = listData?.data?.groups ?? [];
    const adminGroup = allGroups.find(g => g.displayName === 'admins');
    if (!adminGroup) return { ok: false, reason: '`admins` group not found' };

    // 3) Add.
    const addRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        query: LLDAP_GRAPHQL_ADD_USER_TO_GROUP,
        variables: { userId: 'admin', groupId: adminGroup.id },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!addRes.ok) return { ok: false, reason: `addUserToGroup HTTP ${addRes.status}` };
    const addData = await addRes.json();
    if (addData?.errors?.length) {
      return { ok: false, reason: addData.errors[0]?.message || 'unknown' };
    }
    return { ok: addData?.data?.addUserToGroup?.ok === true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * #988 — Provision an LLDAP user for the operator (typically derived
 * from `OPERATOR_EMAIL` captured in the wizard) and add them to the
 * `admins` group. Idempotent: a pre-existing user is treated as
 * success and the group membership is reconciled.
 *
 * Password is NOT set here. LLDAP uses the OPAQUE protocol for
 * passwords; they cannot be set over GraphQL with a plaintext value.
 * The operator finishes provisioning by clicking their user in the
 * LLDAP UI and using "Set password" — but the catch-22 (needing
 * admin-domain access to reach the UI) is gone because the LLDAP
 * built-in `admin` user is already in `admins` via the seed flow.
 */
async function provisionOperatorUser(
  baseUrl: string,
  token: string,
  operator: { uid: string; email: string; displayName?: string },
): Promise<{ ok: boolean; uid?: string; created?: boolean; reason?: string }> {
  try {
    // 1) Create. LLDAP returns a duplicate-key error if the user
    // already exists — treat that as success-with-created=false.
    let created = false;
    const createRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        query: LLDAP_GRAPHQL_CREATE_USER,
        variables: {
          user: {
            id: operator.uid,
            email: operator.email,
            displayName: operator.displayName ?? operator.uid,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!createRes.ok) {
      return { ok: false, uid: operator.uid, reason: `createUser HTTP ${createRes.status}` };
    }
    const createData = await createRes.json();
    if (createData?.errors?.length) {
      const msg: string = createData.errors[0]?.message ?? '';
      const lower = msg.toLowerCase();
      if (!(lower.includes('already exists') || lower.includes('duplicate') || lower.includes('unique constraint'))) {
        return { ok: false, uid: operator.uid, reason: msg };
      }
      // user already exists — fall through to group add
    } else if (createData?.data?.createUser?.id) {
      created = true;
    }

    // 2) Add to `admins` (idempotent; reuses the same lookup pattern
    // as grantAdminGroup above).
    const memberRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: LLDAP_GRAPHQL_USER_GROUPS, variables: { userId: operator.uid } }),
      signal: AbortSignal.timeout(5000),
    });
    if (memberRes.ok) {
      const data = await memberRes.json();
      const groupsForUser: Array<{ displayName?: string }> = data?.data?.user?.groups ?? [];
      if (groupsForUser.some(g => g.displayName === 'admins')) {
        return { ok: true, uid: operator.uid, created };
      }
    }
    const listRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: LLDAP_GRAPHQL_LIST_GROUPS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!listRes.ok) return { ok: false, uid: operator.uid, reason: `groups query HTTP ${listRes.status}` };
    const listData = await listRes.json();
    const allGroups: Array<{ id: number; displayName: string }> = listData?.data?.groups ?? [];
    const adminGroup = allGroups.find(g => g.displayName === 'admins');
    if (!adminGroup) return { ok: false, uid: operator.uid, reason: '`admins` group not found' };

    const addRes = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        query: LLDAP_GRAPHQL_ADD_USER_TO_GROUP,
        variables: { userId: operator.uid, groupId: adminGroup.id },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!addRes.ok) return { ok: false, uid: operator.uid, reason: `addUserToGroup HTTP ${addRes.status}` };
    const addData = await addRes.json();
    if (addData?.errors?.length) return { ok: false, uid: operator.uid, reason: addData.errors[0]?.message ?? 'unknown' };
    return { ok: addData?.data?.addUserToGroup?.ok === true, uid: operator.uid, created };
  } catch (e) {
    return { ok: false, uid: operator.uid, reason: e instanceof Error ? e.message : String(e) };
  }
}
