import type { SessionPayload } from '@/lib/auth/session';
import { redactLogText, redactServiceFiles } from '@/lib/mcp/redact';

/**
 * Redact box-derived text before it reaches a **token** principal (#2943).
 *
 * `read` is the tier this codebase treats as safe to hand out: `/napi/pair/redeem`
 * gives any paired companion device `['read']` for 30 days, and delegated `read`
 * children go into agent containers. The MCP twins of these reads
 * (`get_service_files`, `get_logs`) have redacted since #321 — the HTTP routes
 * returned the same rendered pod YAML (`value: "<SHARE_PASSWORD>"` inline) and the
 * same first-run admin-password log lines verbatim.
 *
 * The discriminator is the one `/api/settings` already uses (#1275): `requireSession`
 * tags a token principal `token:<name>`, and so does the token→session **bridge**
 * (`POST /api/auth/session-from-token`) — so a `read` token traded for a cookie is
 * still recognised here. A cookie operator (password login, `user` = their name) and
 * the internal server-to-server principal (`user: 'internal'`) are untouched and keep
 * plaintext.
 *
 * One seam, so a route that opens itself to a token principal redacts the same way
 * every other one does. `tests/backend/token_principal_secret_redaction.test.ts` is
 * the class gate over the routes that use it.
 */

/** Is this request's principal a named API token (Bearer, or a session bridged
 *  from one)? `undefined` — an unauthenticated public GET — is not. Deliberately
 *  module-local: a route asks one of the two typed helpers below, so the branch
 *  and the redaction pass that follows it can never be wired up separately. */
function isTokenPrincipal(auth?: Pick<SessionPayload, 'user'>): boolean {
  return auth?.user?.startsWith('token:') ?? false;
}

/**
 * A `getServiceFiles` payload, redacted for a token principal and verbatim for
 * everyone else. Same `redactServiceFiles` the MCP `get_service_files` tool runs,
 * so the two surfaces cannot drift.
 */
export function serviceFilesForPrincipal<T extends {
  kubeContent?: string;
  yamlContent?: string;
  serviceContent?: string;
}>(auth: Pick<SessionPayload, 'user'> | undefined, files: T): T {
  return isTokenPrincipal(auth) ? redactServiceFiles(files) : files;
}

/**
 * Free-form log text (journal, `podman logs`, gateway device log), redacted for a
 * token principal and verbatim for everyone else. Same `redactLogText` the MCP
 * `get_logs` tool runs.
 */
export function logTextForPrincipal(
  auth: Pick<SessionPayload, 'user'> | undefined,
  text: string,
): string {
  return isTokenPrincipal(auth) ? redactLogText(text) : text;
}
