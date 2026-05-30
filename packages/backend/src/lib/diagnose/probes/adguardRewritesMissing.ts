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

// diffRewrites compares the live AdGuard rewrites against the expected set,
// returning the domains with no rewrite (missing) and those pointing somewhere
// other than the LAN IP (stale). Extracted to keep the probe under the line limit.
function diffRewrites(
  actual: ReadonlyArray<{ domain: string; answer: string }>,
  expected: string[],
  lanIp: string,
): { missing: string[]; stale: string[] } {
  const byDomain = new Map(actual.map(r => [r.domain, r.answer]));
  const missing: string[] = [];
  const stale: string[] = [];
  for (const d of expected) {
    const got = byDomain.get(d);
    if (got === undefined) missing.push(d);
    else if (got !== lanIp) stale.push(`${d} → ${got}`);
  }
  return { missing, stale };
}

// okRewritesDetail builds the all-good message: lists the mapped domains when
// there are few enough to scan (#550), else a count. Extracted to keep the
// probe under the line limit.
function okRewritesDetail(expected: string[], lanIp: string): string {
  const LISTING_THRESHOLD = 5;
  if (expected.length <= LISTING_THRESHOLD) {
    const listing = expected.map(d => `${d} → ${lanIp}`).join(', ');
    return `${expected.length} portal/wildcard rewrite${expected.length === 1 ? '' : 's'} in AdGuard: ${listing}.`;
  }
  return `${expected.length} portal/wildcard rewrites in AdGuard point at ${lanIp}.`;
}

// resolveAdguardContext runs the precondition guards (installed? creds? lanIp?)
// and, when all pass, returns the AdGuard admin credentials + lanIp + expected
// rewrites. Returns { skip } with the early-return result otherwise. Extracted
// to keep the probe under the line/complexity limits.
function resolveAdguardContext(
  config: Awaited<ReturnType<typeof getConfig>>,
):
  | { skip: AdguardRewritesMissingResult }
  | { creds: { adminUrl: string; username: string; password: string }; lanIp: string; expected: string[] } {
  if (!config.installedTemplates?.adguard) {
    return { skip: { status: 'ok', detail: 'AdGuard is not installed — DNS rewrite check skipped.' } };
  }
  const adguard = config.adguard;
  if (!adguard?.password) {
    return { skip: { status: 'info', detail: 'AdGuard credentials are not recorded yet — DNS rewrite check skipped.' } };
  }
  const lanIp = config.reverseProxy?.lanIp;
  if (!lanIp) {
    return { skip: { status: 'info', detail: 'No LAN IP recorded in config — DNS rewrite check skipped.' } };
  }
  const expected = buildExpectedRewrites(config.reverseProxy?.lanDomain, config.reverseProxy?.publicDomain);
  return {
    creds: {
      adminUrl: adguard.adminUrl || `http://localhost:${config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083'}`,
      username: adguard.username || 'admin',
      password: adguard.password,
    },
    lanIp,
    expected,
  };
}

export async function checkAdguardRewritesMissing(): Promise<AdguardRewritesMissingResult> {
  const config = await getConfig();

  const ctx = resolveAdguardContext(config);
  if ('skip' in ctx) return ctx.skip;
  const { creds, lanIp, expected } = ctx;

  let actual: Awaited<ReturnType<typeof listRewrites>>;
  try {
    actual = await listRewrites(creds);
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
  const { missing, stale } = diffRewrites(actual, expected, lanIp);

  if (missing.length === 0 && stale.length === 0) {
    return { status: 'ok', detail: okRewritesDetail(expected, lanIp) };
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
 *  operator sees which rewrites were added vs unchanged.
 *
 *  Exported (not just registered) so `domain_unreachable` can mount
 *  the same handler under its own action namespace when it diagnoses
 *  a missing/drifted AdGuard rewrite — operator clicks the button on
 *  the failing domain row directly, no probe-to-probe navigation.
 */
export async function reprovision(): Promise<ProbeActionResult> {
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
