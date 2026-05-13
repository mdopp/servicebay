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
    const data = await res.json().catch(() => ({})) as {
      data?: { createUser?: { id: string; displayName?: string } };
      errors?: Array<{ message?: string }>;
    };
    if (data.errors?.length) {
      const msg = data.errors[0]?.message ?? 'Unknown LLDAP error.';
      const lower = msg.toLowerCase();
      if (lower.includes('already exists') || lower.includes('duplicate')) {
        return { ok: false, reason: 'username_taken', message: `The username "${input.id}" is already in use in LLDAP.` };
      }
      return { ok: false, reason: 'graphql_error', message: msg };
    }
    const created = data.data?.createUser;
    if (!created) {
      return { ok: false, reason: 'graphql_error', message: 'LLDAP response did not include the created user.' };
    }
    return { ok: true, userId: created.id, displayName: created.displayName ?? input.displayName ?? input.id };
  } catch (e) {
    return { ok: false, reason: 'network_error', message: e instanceof Error ? e.message : 'Network error talking to LLDAP.' };
  }
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
 */
export async function getLldapUserDeepLink(userId: string): Promise<string | null> {
  const config = await getConfig();
  const proxied = config.reverseProxy?.hosts?.find(h => h.service === 'lldap' && h.created);
  const base = proxied ? `https://${proxied.domain}` : config.lldap?.url;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/user/${encodeURIComponent(userId)}`;
}
