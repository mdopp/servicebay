import { listLldapUsers } from '@/lib/lldap/client';

/** Default max users (approved LLDAP users + pending access requests) when
 *  `config.maxUsers` is unset. A small household can set it lower (#1426). */
export const DEFAULT_MAX_USERS = 20;

/**
 * Is the server at/over its user cap? Denominator = approved LLDAP users +
 * pending access requests (#1426).
 *
 * Best-effort on the LLDAP count: if LLDAP is unreachable we can't size the
 * cap, so this returns `false` (the caller falls back to the pending-request
 * guard rather than block legitimate requests on an LLDAP hiccup).
 */
export async function isOverUserLimit(maxUsers: number, pendingCount: number): Promise<boolean> {
  const usersResult = await listLldapUsers();
  if (!usersResult.ok) return false;
  return usersResult.users.length + pendingCount >= maxUsers;
}
