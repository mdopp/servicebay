/**
 * `adguard_rewrites_missing` probe — surfaces when AdGuard is missing
 * the portal-apex / wildcard DNS rewrites that LAN devices need in
 * order to resolve `<sub>.<domain>` to ServiceBay's LAN IP.
 *
 * The install-time provisioner (`provisionPortalRouting`) is invoked
 * fire-and-forget after AdGuard's post-deploy stamps credentials, and
 * again 60s after server boot. Either invocation can silently fail
 * — AdGuard not yet listening, auth flapping, /control/rewrite/list
 * returning non-200 — and the operator gets no feedback until they
 * notice that *.<domain> doesn't resolve. This probe is the safety
 * net: it derives the expected set the same way the provisioner does
 * and compares it to what AdGuard actually has, surfacing a
 * single-button "Reprovision" action that re-runs the same code path.
 *
 * Detection (per `getActiveDomain` / `provisionPortalRouting`):
 *   - lanDomain (default `home.arpa`) always contributes three entries:
 *       <lanDomain>, www.<lanDomain>, *.<lanDomain>  → lanIp
 *   - publicDomain (when set) contributes the same trio for itself.
 * A rewrite is "missing" if the expected domain isn't present at all,
 * and "stale" if it points at an IP that isn't the current lanIp.
 */

import { getConfig } from '@/lib/config';
import { listRewrites } from '@/lib/adguard/rewrites';
import { provisionPortalRouting } from '@/lib/portal/provisioner';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'adguard_rewrites_missing';
const DEFAULT_LAN_DOMAIN = 'home.arpa';

export interface AdguardRewritesMissingResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

/** Build the expected set of AdGuard rewrite domains for the current
 *  install. Mirrors the loop inside `provisionPortalRouting` so the
 *  two stay in lockstep — if that function changes the rewrite shape,
 *  this needs to follow.
 *
 *  Single-domain model: `publicDomain` when set, `home.arpa`
 *  otherwise. There's no longer a dual-rewrite (both home.arpa AND
 *  publicDomain) because the publicDomain wildcard alone covers
 *  every LAN client's resolution needs once the operator has a
 *  domain. */
function buildExpectedRewrites(
  _lanDomain: string | undefined,
  publicDomain: string | undefined,
): string[] {
  const target = (publicDomain?.trim()) || DEFAULT_LAN_DOMAIN;
  return [target, `www.${target}`, `*.${target}`];
}

export async function checkAdguardRewritesMissing(): Promise<AdguardRewritesMissingResult> {
  const config = await getConfig();

  // Skip when AdGuard isn't installed — nothing to provision against.
  // The npm/cert/pods probes already cover the "service missing" case.
  if (!config.installedTemplates?.adguard) {
    return {
      status: 'ok',
      detail: 'AdGuard is not installed — DNS rewrite check skipped.',
    };
  }

  const adguard = config.adguard;
  if (!adguard?.password) {
    // Credentials live in a separate config block written by AdGuard's
    // post-deploy. Without them we can't query /control/rewrite/list —
    // surface as info so the probe doesn't masquerade as healthy, and
    // leave the actual remediation to the credentials-saving flow.
    return {
      status: 'info',
      detail: 'AdGuard credentials are not recorded yet — DNS rewrite check skipped.',
    };
  }

  const lanIp = config.reverseProxy?.lanIp;
  if (!lanIp) {
    return {
      status: 'info',
      detail: 'No LAN IP recorded in config — DNS rewrite check skipped.',
    };
  }

  const expected = buildExpectedRewrites(
    config.reverseProxy?.lanDomain,
    config.reverseProxy?.publicDomain,
  );

  let actual: Awaited<ReturnType<typeof listRewrites>>;
  try {
    actual = await listRewrites({
      adminUrl:
        adguard.adminUrl ||
        `http://localhost:${config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083'}`,
      username: adguard.username || 'admin',
      password: adguard.password,
    });
  } catch (e) {
    return {
      status: 'info',
      detail: `Could not reach AdGuard to list rewrites: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }

  // `listRewrites` swallows network/auth failures and returns []. An
  // empty list against an installed AdGuard is more likely "rewrites
  // were never created" than "AdGuard has zero rewrites by design",
  // so we lean toward warn — the Reprovision action is safe either
  // way because `ensureWildcardRewrite` is idempotent.
  const byDomain = new Map(actual.map(r => [r.domain, r.answer]));
  const missing: string[] = [];
  const stale: string[] = [];
  for (const d of expected) {
    const got = byDomain.get(d);
    if (got === undefined) missing.push(d);
    else if (got !== lanIp) stale.push(`${d} → ${got}`);
  }

  if (missing.length === 0 && stale.length === 0) {
    return {
      status: 'ok',
      detail: `${expected.length} portal/wildcard rewrite${
        expected.length === 1 ? '' : 's'
      } in AdGuard point at ${lanIp}.`,
    };
  }

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.length} missing (${missing.join(', ')})`);
  if (stale.length > 0) {
    parts.push(`${stale.length} pointing elsewhere (${stale.join('; ')})`);
  }

  return {
    status: 'warn',
    detail: `AdGuard DNS rewrites incomplete: ${parts.join('; ')}.`,
    hint: 'LAN devices can\'t resolve service subdomains to ServiceBay until these exist. Click "Reprovision" to re-run the install-time provisioner — it is idempotent and only touches the entries that are missing or stale.',
  };
}

/** Action handler — re-runs `provisionPortalRouting` end-to-end, the
 *  same code path the install wizard and the 60s-post-boot hook use.
 *  Surfaces the structured `detail` summary as `details` so the
 *  operator sees which rewrites were added vs unchanged. */
async function reprovision(): Promise<ProbeActionResult> {
  try {
    const result = await provisionPortalRouting();
    if (!result.ok) {
      return {
        ok: false,
        message: `Reprovision finished with errors: ${result.detail}`,
        details: result.detail,
        refresh: true,
      };
    }
    return {
      ok: true,
      message: 'AdGuard rewrites reprovisioned.',
      details: result.detail,
      refresh: true,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('diagnose:adguard_rewrites_missing', `Reprovision threw: ${message}`);
    return {
      ok: false,
      message: `Reprovision failed: ${message}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reprovision',
    label: 'Reprovision',
    description:
      'Re-runs the install-time portal provisioner: adds the apex, www, and wildcard DNS rewrites for your active domains and the LAN domain. Idempotent — existing rewrites with the right answer are left untouched.',
  },
  reprovision,
);
