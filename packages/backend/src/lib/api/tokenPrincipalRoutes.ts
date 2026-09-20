import type { ApiScope } from '@/lib/auth/apiScope';

/**
 * What a **token principal** must hold to reach a route that declares no scope
 * of its own (#2958).
 *
 * A token principal is a caller whose identity is a named API token — either a
 * raw `Authorization: Bearer sb_…`, or a session cookie minted from one by
 * `POST /api/auth/session-from-token`. The bridged cookie is the interesting
 * half: it carries `scopes = token.scopes`, so `requireSession` can recognise
 * it, but until this registry existed there was nothing to compare those scopes
 * *against* on a route that named none. `cookieScopeRefusal` returned `null` and
 * the request went through unchecked.
 *
 * That is the asymmetry this file closes. On a route with no `tokenScope`, a
 * bearer is refused outright — `requireSession` never opens the Bearer branch.
 * The cookie path had no such floor, so the same token reached *more* through
 * the bridge than it could reach directly: a `read`-only token's cookie could
 * `POST /api/system/factory-reset`, which its bearer could not touch. Two
 * container-log routes were pulled back one at a time in #2943; this registry
 * is the class-wide replacement for that per-route patching.
 *
 * **Silence is not a decision.** A route that is missing here is refused to
 * every token principal — {@link gateForTokenPrincipal} defaults to `'deny'` —
 * so a route added tomorrow is covered by construction, and
 * `tests/backend/cookie_scope_parity.test.ts` turns red until somebody writes
 * the classification down.
 *
 * A **password login is not a token principal** and never consults this file:
 * its session carries no `scopes`, and `requireSession` returns before the
 * lookup. Nothing here changes what the operator's own browser can do.
 */
export type TokenPrincipalGate =
  /** Hold the token principal to this scope, exactly as a `tokenScope` route would. */
  | ApiScope
  /** No token principal reaches this route by cookie — matching the bearer path,
   *  which cannot reach it at all. */
  | 'deny'
  /** Reachable by any principal: the route carries nothing a scope protects. */
  | 'any';

export interface TokenPrincipalRule {
  /** HTTP method of the exported handler. `HEAD` is looked up as `GET`. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Next.js route path, dynamic segments included verbatim: `/api/services/[name]`. */
  path: string;
  gate: TokenPrincipalGate;
  /** Why this classification, in words. The point of the ledger. */
  reason: string;
}

/**
 * The written reasons. Shared where the reason genuinely is the same class of
 * route — the entry below still names its own gate, one line per handler.
 */
const R = {
  ANON:
    'Anonymous-reachable surface (mirrors `proxy.ts:PUBLIC_API_RULES`) — a caller ' +
    'with no session at all already gets this, so demanding a scope of a token ' +
    'principal would protect nothing and would break the login/portal flow.',
  SELF:
    "Returns only the caller's own session identity. Every principal already holds " +
    'that; the bridged UI cannot render without it.',
  DOCS:
    'Serves static in-repo documentation, byte-identical for every caller and ' +
    'derived from no box state.',
  DASH_READ:
    'Read-only view of box state. `read` is the tier this codebase already treats ' +
    'as safe to hand out, and the MCP twin of the same view requires it — so the ' +
    'bridged cookie is held to exactly what the bearer would need.',
  LOG_READ:
    'Read-only log surface. Same `read` tier as the MCP `get_logs` twin, and the ' +
    'body is redacted for a token principal (`principalRedaction.ts`, #2943).',
  SECRET_READ:
    'Hands back a stored credential or private key in the clear. No bearer can ' +
    'reach it, and the bridge must not become the way in.',
  HOST_FILE_READ:
    'Reads host file content chosen by the caller — `exec`-tier reach in practice. ' +
    'No bearer can reach it, and the bridge must not become the way in.',
  MUTATE_ADMIN:
    'Operator-console mutation with no declared token scope: the bearer path ' +
    'refuses it outright, so the cookie path refuses it too.',
  DESTRUCTIVE:
    'Irreversible or host-level action. The bearer path refuses it outright; a ' +
    'token principal must not get there by trading itself a cookie.',
  INSTALL_FLOW:
    'Install/onboarding step driven by the operator console and by post-deploy ' +
    'scripts on the internal token. Neither path is a token principal.',
  SECRET_WRITE:
    'Writes or rotates a stored credential. The bearer path refuses it outright; ' +
    'the cookie path must refuse it identically.',
} as const;

/**
 * One entry per route handler that declares neither `tokenScope` nor
 * `cookieScope` nor `skipAuth`. Kept sorted by path; the class gate holds this
 * list against the route tree in both directions, so it cannot drift.
 */
export const TOKEN_PRINCIPAL_ROUTES: readonly TokenPrincipalRule[] = [
  { method: 'POST', path: '/api/approvals', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/assists/[id]/history', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/assists/[id]/propose', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/auth/lldap-url', gate: 'any', reason: R.ANON },
  { method: 'GET', path: '/api/auth/me', gate: 'any', reason: R.SELF },
  { method: 'GET', path: '/api/auth/oidc', gate: 'any', reason: R.ANON },
  { method: 'GET', path: '/api/auth/oidc/callback', gate: 'any', reason: R.ANON },
  { method: 'GET', path: '/api/auth/oidc/status', gate: 'any', reason: R.ANON },
  { method: 'GET', path: '/api/containers', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/containers/[id]', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/containers/[id]/action', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/containers/[id]/logs', gate: 'read', reason: R.LOG_READ },
  { method: 'GET', path: '/api/containers/[id]/logs/stream', gate: 'read', reason: R.LOG_READ },
  { method: 'DELETE', path: '/api/health/checks', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'POST', path: '/api/health/checks', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/health/checks/[id]/history', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/health/checks/[id]/run', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/help', gate: 'any', reason: R.DOCS },
  { method: 'GET', path: '/api/history/[filename]', gate: 'deny', reason: R.HOST_FILE_READ },
  { method: 'POST', path: '/api/install/credentials', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'POST', path: '/api/install/generate-secret', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'GET', path: '/api/install/progress', gate: 'any', reason: R.ANON },
  { method: 'GET', path: '/api/install/status', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/logs/list', gate: 'read', reason: R.LOG_READ },
  { method: 'GET', path: '/api/logs/query', gate: 'read', reason: R.LOG_READ },
  { method: 'GET', path: '/api/logs/tags', gate: 'read', reason: R.LOG_READ },
  { method: 'DELETE', path: '/api/network/edges', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'POST', path: '/api/network/edges', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/network/graph', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/portal/asset/[service]/[kind]', gate: 'any', reason: R.ANON },
  { method: 'POST', path: '/api/services', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'DELETE', path: '/api/services/[name]', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'PUT', path: '/api/services/[name]', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/services/[name]/action-stream', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/services/[name]/reconfigure-preview', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/services/[name]/rename', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/services/[name]/status', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/services/validate-yaml', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/settings/backup-sync', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/settings/backup-sync', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/settings/backup-sync/mounts', gate: 'read', reason: R.DASH_READ },
  { method: 'DELETE', path: '/api/settings/backups', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/settings/backups/download', gate: 'deny', reason: R.HOST_FILE_READ },
  { method: 'POST', path: '/api/settings/backups/file', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/settings/backups/preview', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/settings/gateway', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/settings/gateway', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/settings/logLevel', gate: 'read', reason: R.DASH_READ },
  { method: 'PUT', path: '/api/settings/logLevel', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/stream', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/access-requests', gate: 'read', reason: R.DASH_READ },
  { method: 'DELETE', path: '/api/system/access-requests/[id]', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'PATCH', path: '/api/system/access-requests/[id]', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/access-requests/[id]/approve', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/access-requests/[id]/welcome', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'DELETE', path: '/api/system/adguard/credentials', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/adguard/credentials', gate: 'deny', reason: R.SECRET_READ },
  { method: 'POST', path: '/api/system/adguard/credentials', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/authelia/oidc-clients', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'DELETE', path: '/api/system/authelia/oidc-clients/[client_id]', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/core-health', gate: 'read', reason: R.DASH_READ },
  { method: 'DELETE', path: '/api/system/credentials', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/credentials', gate: 'deny', reason: R.SECRET_READ },
  { method: 'POST', path: '/api/system/credentials', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/credentials/handover', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/credentials/handover/confirm', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'GET', path: '/api/system/devices', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/diagnose/run-action', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/discovery', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/discovery/dismiss', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/dns/verify', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/downloads/basicsync', gate: 'any', reason: R.ANON },
  { method: 'POST', path: '/api/system/factory-reset', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/file-share/samba/users', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/file-share/samba/users', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/file-share/samba/users/[id]/set-password', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/filebrowser/init', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'GET', path: '/api/system/files', gate: 'deny', reason: R.HOST_FILE_READ },
  { method: 'GET', path: '/api/system/gateway/detect', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/hermes/chat', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/hermes/chat', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/keys/rsa', gate: 'deny', reason: R.SECRET_READ },
  { method: 'DELETE', path: '/api/system/lldap/credentials', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/lldap/credentials', gate: 'deny', reason: R.SECRET_READ },
  { method: 'POST', path: '/api/system/lldap/credentials', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/lldap/probe', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'POST', path: '/api/system/lldap/seed', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'GET', path: '/api/system/mcp-audit', gate: 'read', reason: R.LOG_READ },
  { method: 'POST', path: '/api/system/media/init', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'GET', path: '/api/system/mode', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/mode', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/nginx/bootstrap', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'DELETE', path: '/api/system/nginx/credentials', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/nginx/credentials', gate: 'deny', reason: R.SECRET_READ },
  { method: 'POST', path: '/api/system/nginx/credentials', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/nginx/install', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'GET', path: '/api/system/nginx/status', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/nodes', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/nodes', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'DELETE', path: '/api/system/nodes/[name]', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'PATCH', path: '/api/system/nodes/[name]', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/nodes/[name]/default', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/notifications/email/test', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/onboarding', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/onboarding/complete', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'POST', path: '/api/system/onboarding/config', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'DELETE', path: '/api/system/onboarding/install-lock', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/os-updates', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/portal-settings', gate: 'read', reason: R.DASH_READ },
  { method: 'PUT', path: '/api/system/portal-settings', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/portal/provision', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'DELETE', path: '/api/system/reinstall', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/reinstall', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/reverse-proxy/migrate-to-public', gate: 'deny', reason: R.INSTALL_FLOW },
  { method: 'GET', path: '/api/system/reverse-proxy/preflight', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/services', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/ssh/check', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'POST', path: '/api/system/ssh/install-key', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/ssh/key', gate: 'deny', reason: R.SECRET_WRITE },
  { method: 'POST', path: '/api/system/ssh/verify', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/stacks/[name]/status', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/stacks/reset', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/stacks/reset/info', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/storage', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/storage', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/templates/[name]/upgrade-preview', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/update', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/system/update', gate: 'deny', reason: R.DESTRUCTIVE },
  { method: 'GET', path: '/api/system/update-window', gate: 'read', reason: R.DASH_READ },
  { method: 'PUT', path: '/api/system/update-window', gate: 'deny', reason: R.MUTATE_ADMIN },
  { method: 'GET', path: '/api/system/verify-lan-dns', gate: 'read', reason: R.DASH_READ },
  { method: 'GET', path: '/api/system/version', gate: 'read', reason: R.DASH_READ },
  { method: 'POST', path: '/api/templates/parse-dependencies', gate: 'deny', reason: R.MUTATE_ADMIN },
];

/** `/api/services/[name]/status` → `^/api/services/[^/]+/status$`. */
function toMatcher(path: string): RegExp {
  const escaped = path
    .split('/')
    .map(seg => (seg.startsWith('[') && seg.endsWith(']')
      ? '[^/]+'
      : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

const MATCHERS: { method: string; re: RegExp; rule: TokenPrincipalRule }[] =
  TOKEN_PRINCIPAL_ROUTES.map(rule => ({ method: rule.method, re: toMatcher(rule.path), rule }));

/**
 * The gate a token principal faces on `method pathname`, for a route that
 * declared no scope of its own.
 *
 * **Defaults to `'deny'`** — an unclassified route is refused, not opened. That
 * default is the whole guarantee: a route landing tomorrow is closed to the
 * bridge before anyone remembers this file exists.
 */
export function gateForTokenPrincipal(method: string, pathname: string): TokenPrincipalGate {
  const wanted = method === 'HEAD' ? 'GET' : method.toUpperCase();
  const hit = MATCHERS.find(m => m.method === wanted && m.re.test(pathname));
  return hit?.rule.gate ?? 'deny';
}
