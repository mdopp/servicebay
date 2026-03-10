import { NextResponse } from 'next/server';

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

/** Wait for LLDAP to become reachable, polling up to maxWait ms. */
async function waitForLldap(baseUrl: string, maxWait = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${baseUrl}/api/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(3000),
      });
      // LLDAP returns 401 for unauthenticated requests — that means it's up
      if (res.status === 401 || res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/** Authenticate with LLDAP and get a JWT token. */
async function authenticate(baseUrl: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
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
  const body = await request.json() as SeedRequest;
  const host = body.host || 'localhost';
  const port = body.port || 17170;
  const password = body.password;
  const groups = body.groups || DEFAULT_GROUPS;

  if (!password) {
    return NextResponse.json({ error: 'Missing LLDAP admin password' }, { status: 400 });
  }

  const baseUrl = `http://${host}:${port}`;

  // Wait for LLDAP to be ready (it may have just been installed)
  const ready = await waitForLldap(baseUrl);
  if (!ready) {
    return NextResponse.json({ error: 'LLDAP not reachable — it may still be starting up' }, { status: 503 });
  }

  // Authenticate
  const token = await authenticate(baseUrl, password);
  if (!token) {
    return NextResponse.json({ error: 'Failed to authenticate with LLDAP — check admin password' }, { status: 401 });
  }

  // Create groups
  const results = await Promise.all(groups.map(g => createGroup(baseUrl, token, g)));
  const created = results.filter(r => r.created).map(r => r.name);
  const existing = results.filter(r => !r.created && !r.error).map(r => r.name);
  const failed = results.filter(r => r.error).map(r => ({ name: r.name, error: r.error }));

  return NextResponse.json({ created, existing, failed });
}
