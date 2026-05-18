import { NextResponse } from 'next/server';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

const LLDAP_GRAPHQL_GROUPS = `
  mutation CreateGroup($name: String!) {
    createGroup(name: $name) {
      id
      displayName
    }
  }
`;

interface SeedRequest {
  host?: string;
  port?: number;
  password: string;
  groups?: string[];
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
      // "already exists" is fine
      if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('duplicate')) {
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
export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

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

  return NextResponse.json({ created, existing, failed });
}
