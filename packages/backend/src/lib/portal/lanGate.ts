/**
 * Optional LAN-only gate for the family `/portal` page (#1456).
 *
 * When `config.portalLanOnly` is on, the portal renders only for
 * LAN-shaped clients so the request-access landing page isn't publicly
 * reachable. This is an app-level gate: the portal page resolves the
 * real client IP (loopback peer → trust NPM's `X-Real-IP` / last XFF
 * hop, same rule the MCP bootstrap-token gate uses) and classifies it
 * with `isLanIp`. A proxy access-list would be stronger, but the issue
 * scoped the app gate as the simpler, non-`security` choice; the public
 * request-access POST endpoint keeps its own cap + anti-spam guards.
 */

import { isLanIp, clientIpForLanGate } from '@/lib/mcp/bootstrapToken';

/**
 * Decide whether to block the portal render for this request.
 *
 *   - `lanOnly` off → never block (returns false regardless of IP).
 *   - `lanOnly` on  → block when the resolved client IP isn't LAN-shaped.
 *
 * `headers` is a plain lower-cased header map (Next's `headers()` is
 * already lower-cased); `socketAddr` is the TCP peer when known. Pure
 * and dependency-free so it unit-tests without a request.
 */
export function isPortalBlockedForRequest(
  lanOnly: boolean | undefined,
  headers: Record<string, string | string[] | undefined>,
  socketAddr: string | undefined,
): boolean {
  if (!lanOnly) return false;
  const clientIp = clientIpForLanGate(headers, socketAddr);
  return !isLanIp(clientIp);
}
