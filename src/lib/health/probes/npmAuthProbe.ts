/**
 * `npm_auth` probe — verifies that the stored NPM admin credentials
 * still work against the locally-running NPM instance. Filename has
 * the `Probe` suffix to avoid clashing with the existing utility
 * module `npmAdmin.ts` in this directory.
 */

import { registerProbe } from './registry';
import { getConfig } from '../../config';
import { findNpmAdminUrl } from './npmAdmin';

export const NPM_AUTH_MESSAGE_PREFIX = 'npm_auth:';

type Payload = { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string };

const encode = (payload: Payload) => ({
  status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const),
  message: `${NPM_AUTH_MESSAGE_PREFIX}${JSON.stringify(payload)}`,
});

registerProbe({
  type: 'npm_auth',
  async run(check) {
    const node = check.nodeName ?? 'Local';
    try {
      const config = await getConfig();
      const npm = config.reverseProxy?.npm;
      if (!npm?.email || !npm?.password) {
        return encode({ status: 'info', detail: 'No NPM admin credentials stored — skipping staleness check.' });
      }
      const admin = await findNpmAdminUrl(node);
      if (admin.kind === 'twin-not-ready') {
        return encode({ status: 'info', detail: 'Digital twin not populated yet — check will retry on the next tick.' });
      }
      if (admin.kind === 'nginx-not-found') {
        return encode({ status: 'info', detail: 'Nginx Proxy Manager not deployed on this node — nothing to check.' });
      }
      const adminUrl = admin.url;
      try {
        const res = await fetch(`${adminUrl}/api/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: npm.email, secret: npm.password }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) return encode({ status: 'ok', detail: 'NPM accepts the stored admin credentials.' });
        if (res.status === 401) {
          return encode({
            status: 'fail',
            detail: 'Nginx Proxy Manager is rejecting the stored admin credentials. This usually means a previous install left an admin password in the NPM database that no longer matches.',
            hint: 'If you know the password NPM is actually using, click "Use existing password" below to save it (no data loss). Otherwise "Reset NPM data" wipes the database and re-seeds with the wizard credentials.',
          });
        }
        return encode({ status: 'info', detail: `NPM auth probe returned HTTP ${res.status} — assuming transient.` });
      } catch (e) {
        return encode({
          status: 'info',
          detail: `Could not reach NPM at ${adminUrl}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } catch (e) {
      return { status: 'fail', message: `npm_auth error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
