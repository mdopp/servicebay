/**
 * LAN-only bootstrap MCP token (#322).
 *
 * The operator types a bootstrap token into the ISO install wizard
 * (`install-fedora-coreos.sh`). That script SHA-256s the cleartext and
 * writes only the hash into `config.auth.bootstrapToken.hash`. The
 * server never sees the cleartext.
 *
 * The token solves the chicken-and-egg between "MCP needs a token to
 * authenticate" and "minting tokens needs a logged-in dashboard
 * session, which on a fresh install hasn't happened yet" — so the
 * operator can run install-time diagnostics from Claude/Cursor without
 * exposing their admin password to a programmatic surface.
 *
 * Defence-in-depth (any failure rejects):
 *   - hash compare via timingSafeEqual
 *   - expiresAt window — lazy-initialised to first-boot + 30 min
 *   - request must originate from loopback or RFC1918 / fc00::/7
 *   - scope is locked to ['read']; tool gates apply as normal
 *
 * Lifecycle (config.auth.bootstrapToken):
 *   install      → { hash, scope: 'read' }
 *   first boot   → above + { expiresAt }   (set by lazyInitializeExpiry)
 *   first user-minted MCP token → entry deleted (revoke from tokens.ts)
 *   manual click → entry deleted (revoke API)
 *   30 min later → entry stays, validation rejects (expired)
 */

import crypto from 'crypto';
import { getConfig, updateConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import type { ApiScope } from './tokens';

const TTL_MIN = 30;

/** Confirm the request comes from a LAN-shaped IP, including the
 *  loopback addresses. Public addresses are rejected outright — this
 *  is the first defence layer before the hash check, so the bootstrap
 *  token can never be exercised from the open internet even if it
 *  somehow leaked. */
export function isLanIp(addr: string | undefined | null): boolean {
  if (!addr) return false;
  // Strip IPv6-mapped prefix (e.g. ::ffff:192.168.0.1)
  const ip = addr.replace(/^::ffff:/, '');
  // IPv4 forms
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // IPv6 forms
  if (ip === '::1') return true;
  // RFC4193 ULA: fc00::/7  (matches fc.. and fd..)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  // IPv6 link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  return false;
}

/**
 * Resolve the real client IP for the LAN-only gate (#1204).
 *
 * Behind a reverse proxy (NPM forwards to 127.0.0.1) `socket.remoteAddress`
 * is always loopback, so `isLanIp()` would pass for every caller — including
 * the public internet if the dashboard is exposed. So: when the socket peer
 * IS loopback we trust the proxy's authoritative client-IP headers — NPM sets
 * `X-Real-IP` to nginx's `$remote_addr` (overwriting any client-sent value),
 * and the LAST `X-Forwarded-For` hop is the one nginx appended. When the peer
 * is NOT loopback (a direct connection) the headers are attacker-controllable,
 * so we ignore them and use the socket address. We never take the left-most
 * XFF entry, which a direct client could spoof with a fake LAN IP.
 */
export function clientIpForLanGate(
  headers: Record<string, string | string[] | undefined>,
  socketAddr: string | undefined,
): string | undefined {
  const loopback = socketAddr === '127.0.0.1' || socketAddr === '::1' || socketAddr === '::ffff:127.0.0.1';
  if (!loopback) return socketAddr;

  const realRaw = headers['x-real-ip'];
  const real = (Array.isArray(realRaw) ? realRaw[0] : realRaw)?.trim();
  if (real) return real;

  const xffRaw = headers['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw;
  if (xff) {
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return socketAddr;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * One-time per-install side effect: when the install script wrote a
 * `hash` but no `expiresAt`, persist `expiresAt = now + 30 min`.
 * Subsequent boots see expiresAt already set and leave it alone — so
 * the 30-min window starts at first boot, not at validate time, and
 * doesn't reset on reboot.
 *
 * Idempotent. Safe to call from server.ts boot.
 */
export async function lazyInitializeExpiry(): Promise<void> {
  const config = await getConfig();
  const bt = config.auth?.bootstrapToken;
  if (!bt?.hash) return;
  if (bt.expiresAt) return;
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  await updateConfig({
    auth: {
      bootstrapToken: { ...bt, expiresAt },
    },
  });
  logger.info(
    'mcp:bootstrap',
    `Initialised bootstrap-token expiry to ${expiresAt} (${TTL_MIN} min from first boot)`,
  );
}

/** Try to validate a bearer string as the bootstrap token. Returns the
 *  synthesized auth context on success, null otherwise. Never throws. */
export async function verifyBootstrapToken(
  raw: string,
  remoteIp: string | undefined,
): Promise<{ user: string; scopes: ApiScope[]; tokenId: 'bootstrap' } | null> {
  if (!raw) return null;
  if (!isLanIp(remoteIp)) return null;

  const config = await getConfig();
  const bt = config.auth?.bootstrapToken;
  if (!bt?.hash) return null;

  const incomingHash = Buffer.from(sha256(raw), 'hex');
  const storedHash = Buffer.from(bt.hash, 'hex');
  if (incomingHash.length !== storedHash.length) return null;
  if (!crypto.timingSafeEqual(incomingHash, storedHash)) return null;

  // Hash matches perfectly! Now check if the absolute expiry window has passed.
  let isExpired = false;
  if (bt.expiresAt && Date.parse(bt.expiresAt) < Date.now()) {
    // If standard 30 min expired, keep it alive if a setup job is currently
    // active or completed within the last 30 minutes.
    try {
      const { wasInstallActiveWithin } = await import('@/lib/install/jobStore');
      const isRecent = await wasInstallActiveWithin(30 * 60 * 1000);
      if (!isRecent) {
        isExpired = true;
      }
    } catch {
      // Fallback to absolute expiration if jobStore loading fails
      isExpired = true;
    }
  }

  if (isExpired) {
    throw new Error('Bootstrap token expired. Please generate a fresh API token in Settings.');
  }

  return {
    user: 'bootstrap',
    scopes: ['read'],
    tokenId: 'bootstrap',
  };
}

/** Delete the bootstrap-token entry from config. Called from the
 *  Settings UI, and automatically when the operator mints their first
 *  named MCP token (see tokens.ts createToken). Returns true iff
 *  there was something to revoke. */
export async function revokeBootstrapToken(): Promise<boolean> {
  const config = await getConfig();
  if (!config.auth?.bootstrapToken?.hash) return false;
  // deepMerge in updateConfig only acts on keys present on the source
  // object, so `delete auth.bootstrapToken` would leave the existing
  // entry intact. Explicit `undefined` falls through deepMerge's
  // is-object branch and lands in the result as undefined, which
  // JSON.stringify drops on save — that's the actual delete.
  await updateConfig({
    auth: {
      ...config.auth,
      bootstrapToken: undefined,
    },
  });
  logger.info('mcp:bootstrap', 'Bootstrap MCP token revoked.');
  return true;
}

/** Surface state for the Settings UI. */
export async function getBootstrapTokenStatus(): Promise<
  | { active: false }
  | { active: true; expiresAt: string | null; minutesRemaining: number | null }
> {
  const config = await getConfig();
  const bt = config.auth?.bootstrapToken;
  if (!bt?.hash) return { active: false };
  if (!bt.expiresAt) {
    return { active: true, expiresAt: null, minutesRemaining: null };
  }
  const remainingMs = Date.parse(bt.expiresAt) - Date.now();
  if (remainingMs <= 0) {
    // If standard 30 min expired, check if a setup job is currently
    // active or completed within the last 30 minutes.
    try {
      const { wasInstallActiveWithin } = await import('@/lib/install/jobStore');
      const isRecent = await wasInstallActiveWithin(30 * 60 * 1000);
      if (isRecent) {
        return { active: true, expiresAt: null, minutesRemaining: null };
      }
    } catch {}
    return { active: false };
  }
  return {
    active: true,
    expiresAt: bt.expiresAt,
    minutesRemaining: Math.floor(remainingMs / 60_000),
  };
}
