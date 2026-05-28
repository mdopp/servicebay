import { cookies } from 'next/headers';
import { decrypt } from '@/lib/auth/session';
import { getConfig } from '@/lib/config';

/**
 * Authorization guard for sensitive Server Actions.
 *
 * Server Actions are routed on page paths, so the `/api/*`-only auth gate in
 * `proxy.ts` does NOT cover them — each sensitive action must assert the
 * session itself (#1203). Unauthenticated calls are allowed ONLY while
 * onboarding is incomplete (`!setupCompleted`), so the first-run setup flow
 * still works before any user/credentials exist.
 *
 * Throws `Unauthorized` on a missing/invalid session; callers should let it
 * propagate so the action never runs for an unauthenticated client.
 */
export async function assertAdminSession(): Promise<void> {
  const config = await getConfig();
  if (!config.setupCompleted) return;

  const token = (await cookies()).get('session')?.value;
  const session = token ? await decrypt(token) : null;
  if (!session || typeof session.user !== 'string') {
    throw new Error('Unauthorized');
  }
}
