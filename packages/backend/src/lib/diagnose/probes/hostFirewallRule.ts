/**
 * `host_firewall_rule` probe (#2420) — does the #2388 LAN block ACTUALLY
 * exist in the kernel right now?
 *
 * The rest of the host-firewall code path reports on its own return
 * values: the capability handlers say `{ ok: false }` when a reconcile
 * throws, and the boot reconcile records a standing failure when it does
 * (surfaced by `install_handler_failed`). None of that catches the case
 * this probe is for — a reconcile that returned success while the rule
 * is **not** loaded. Which is not hypothetical: the table can be deleted
 * by hand (it's the documented one-line rollback), the boot unit can be
 * disabled or fail, an `nft` binary can vanish across an rpm-ostree
 * rebase, and a box can simply never have run the boot path.
 *
 * So this probe compares two independently-derived facts:
 *
 *   - **desired** — `planLanBlockedPorts()`, the same computation the
 *     reconcile drives off (installed templates × `blockLanAccess`), but
 *     with no side effects;
 *   - **actual** — `inspectHostFirewall()`, read back from
 *     `nft list table inet servicebay_lanblock` and `systemctl` on the
 *     host.
 *
 * A declared port missing from the live set is a `fail`: an on-box-only
 * port is answering the LAN, which is exactly the exposure #2388 closed.
 * The "loaded but the unit won't bring it back" case is a `warn` — right
 * now it's filtered, but a reboot un-does it.
 */

import { getExecutor } from '@/lib/executor';
import { logger } from '@/lib/logger';
import { inspectHostFirewall, NFT_TABLE, UNIT_NAME, type HostFirewallState } from '@/lib/hostFirewall';
import { planLanBlockedPorts } from '@/lib/capabilities/hostFirewall';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

export const PROBE_ID = 'host_firewall_rule';

/** Single row id — the rule is box-level, so there is only ever one. */
const ITEM_ID = 'lan_block';

export interface HostFirewallRuleResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

const list = (ports: number[]) => ports.join(', ');
const plural = (ports: number[]) => (ports.length === 1 ? '' : 's');

/** One actionable row, so the operator gets a "Re-apply" button on the finding. */
function failingItem(label: string, detail: string, status: 'warn' | 'fail'): ProbeItem[] {
  return [{ id: ITEM_ID, label, detail, status, actionIds: ['reapply_host_firewall'] }];
}

/**
 * Can the host filter at all, and is our table there? Returns null when
 * the answer is "yes, keep checking" so the caller falls through to the
 * port-level comparison.
 */
function reachabilityVerdict(want: number[], state: HostFirewallState): HostFirewallRuleResult | null {
  const wanted = `port${plural(want)} ${list(want)}`;

  if (!state.nftAvailable) {
    return {
      status: 'fail',
      detail:
        `nft is not installed on this box, so the LAN block for ${wanted} cannot be applied — ` +
        `${want.length === 1 ? 'that port answers' : 'those ports answer'} every device on the LAN.`,
      hint: `Install nftables on the host (Fedora CoreOS: \`rpm-ostree install nftables\` + reboot), then click "Re-apply".`,
      items: failingItem(wanted, 'nft binary not found on the host', 'fail'),
    };
  }

  if (state.error) {
    // Couldn't ask. Report that honestly rather than implying "loaded".
    return {
      status: 'warn',
      detail: `Could not read the live nft ruleset, so the LAN block for ${wanted} is unverified — ${state.error}`,
      hint: 'Usually the agent is down or sudo refused the read. Fix that, then re-run diagnose.',
      items: failingItem(wanted, `ruleset query failed: ${state.error}`, 'warn'),
    };
  }

  if (!state.tableLoaded) {
    return {
      status: 'fail',
      detail:
        `The LAN block is NOT loaded: table inet ${NFT_TABLE} is absent from the live ruleset, so ${wanted} ` +
        `${want.length === 1 ? 'is' : 'are'} reachable from every device on the LAN.`,
      hint: `Click "Re-apply" to re-render the rule and restart ${UNIT_NAME}.`,
      items: failingItem(wanted, `table inet ${NFT_TABLE} not present in the live ruleset`, 'fail'),
    };
  }

  return null;
}

/** The table is loaded — does it hold what the templates declared, and
 *  will it still be there after a reboot? */
function portSetVerdict(want: number[], state: HostFirewallState): HostFirewallRuleResult {
  const wanted = `port${plural(want)} ${list(want)}`;
  const missing = want.filter(p => !state.loadedPorts.includes(p));
  if (missing.length > 0) {
    return {
      status: 'fail',
      detail:
        `The live ruleset filters ${state.loadedPorts.length ? `port${plural(state.loadedPorts)} ${list(state.loadedPorts)}` : 'no ports'}, ` +
        `but port${plural(missing)} ${list(missing)} ${missing.length === 1 ? 'is' : 'are'} declared on-box-only and ` +
        `${missing.length === 1 ? 'is' : 'are'} NOT filtered.`,
      hint: `Click "Re-apply" to push the full desired port set back to the host.`,
      items: failingItem(
        `port${plural(missing)} ${list(missing)}`,
        `declared on-box-only but not in the live inet ${NFT_TABLE} set`,
        'fail',
      ),
    };
  }

  if (state.unitActive !== 'active' || state.unitEnabled !== 'enabled') {
    return {
      status: 'warn',
      detail:
        `${wanted} ${want.length === 1 ? 'is' : 'are'} filtered right now, but ${UNIT_NAME} is ` +
        `${state.unitActive}/${state.unitEnabled} — the rule will not come back after a reboot.`,
      hint: 'Click "Re-apply" to reinstall and enable the boot unit.',
      items: failingItem(wanted, `${UNIT_NAME}: ${state.unitActive}, ${state.unitEnabled}`, 'warn'),
    };
  }

  return {
    status: 'ok',
    detail:
      `LAN access is refused for ${wanted} — verified against the live ruleset (table inet ${NFT_TABLE}), ` +
      `with ${UNIT_NAME} enabled so it survives a reboot.`,
  };
}

/** Pure verdict: desired port set vs. what the host actually reported.
 *  Exported so the comparison can be tested without a host. */
export function evaluateHostFirewall(want: number[], state: HostFirewallState): HostFirewallRuleResult {
  return reachabilityVerdict(want, state) ?? portSetVerdict(want, state);
}

export async function checkHostFirewallRule(): Promise<HostFirewallRuleResult> {
  const plan = await planLanBlockedPorts();
  if (plan.ports.length === 0) {
    return {
      status: 'ok',
      detail: 'No installed template declares an on-box-only port, so no host firewall rule is expected.',
    };
  }
  return evaluateHostFirewall(plan.ports, await inspectHostFirewall(getExecutor()));
}

/** Re-render + re-apply the full desired state. Idempotent by construction
 *  (the rendered file IS the desired state and `nft -f` swaps the table
 *  atomically), so clicking twice is harmless. */
async function reapplyHostFirewall(): Promise<ProbeActionResult> {
  const { reconcileHostFirewallOnBoot } = await import('@/lib/capabilities/hostFirewall');
  try {
    await reconcileHostFirewallOnBoot();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('diagnose:host_firewall_rule', `re-apply failed: ${message}`);
    return { ok: false, message: `Could not apply the host firewall rule: ${message}`, refresh: true };
  }
  // Read the host back rather than trusting the call that just returned —
  // the whole point of this probe (#2420).
  const after = await checkHostFirewallRule();
  return after.status === 'ok'
    ? { ok: true, message: after.detail, refresh: true }
    : { ok: false, message: `Applied, but the rule still isn't right: ${after.detail}`, refresh: true };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reapply_host_firewall',
    label: 'Re-apply',
    description:
      'Re-renders the host firewall ruleset from the installed templates and reloads it, then re-checks the live ruleset. Only touches ServiceBay\'s own nft table — podman and the rest of the host firewall are untouched. Safe to click twice.',
  },
  reapplyHostFirewall,
);
