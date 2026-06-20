/**
 * Diagnose orchestrator (#600).
 *
 * Lifted out of `src/app/api/system/diagnose/route.ts` so it can be
 * called from anywhere in the kernel — MCP's `diagnose` tool used to
 * reach back through a faux-fetch (`await import('@/app/api/system/diagnose/route')`),
 * which violated the `lib-no-import-app` invariant. Now the route is a
 * thin wrapper around this function and MCP imports it directly.
 *
 * Same probe set, same response shape, same logging. Pure refactor.
 */

import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import { HealthStore } from '@/lib/health/store';
import { getNodeTwin } from '@/lib/store/repository';
import { actionsForProbe, resolveItemActions, type ProbeAction, type ProbeItem, type ResolvedProbeItem } from '@/lib/diagnose/actions';
import { buildPortSourceMap, renderUnexpectedPort, type TwinPortService, type TwinPortContainer } from '@/lib/diagnose/portsProbe';
import { checkNpmDataStale } from '@/lib/diagnose/probes/npmDataStale';
import { checkLanIpChanged } from '@/lib/diagnose/probes/lanIpChanged';
import { checkRouterDnsNotPointing } from '@/lib/diagnose/probes/routerDnsNotPointing';
import { checkPostDeployFailed } from '@/lib/diagnose/probes/postDeployFailed';
import { checkProxyRouteMissing } from '@/lib/diagnose/probes/proxyRouteMissing';
import { checkCertExpiry } from '@/lib/diagnose/probes/certExpiry';
import { checkCertRequestFailure } from '@/lib/diagnose/probes/certRequestFailure';
import { checkAdguardRewritesMissing } from '@/lib/diagnose/probes/adguardRewritesMissing';
import { checkDomainExternalReachability } from '@/lib/diagnose/probes/domainExternalReachability';
import { checkDomainUnreachable } from '@/lib/diagnose/probes/domainUnreachable';
import { checkDomainResolvesToBox } from '@/lib/diagnose/probes/domainResolvesToBox';
import { checkOidcProviderReachable } from '@/lib/diagnose/probes/oidcProviderReachable';
import { checkNasBackupReachable } from '@/lib/diagnose/probes/nasBackupReachable';
import { checkHaAutomationIntegrity } from '@/lib/diagnose/probes/haAutomationIntegrity';
import { checkSsoVerify } from '@/lib/diagnose/probes/ssoVerify';
import { checkHermesChat } from '@/lib/diagnose/probes/hermesChat';
import { wasInstallActiveWithin } from '@/lib/install/jobStore';
import { persistDiagnoseResults, buildProbeHistory, type ProbeHistory } from '@/lib/diagnose/persistDiagnoseResults';
import '@/lib/diagnose/probes/register';


type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

/**
 * Problem-domain grouping (#1534). The diagnose suite emits ~20 probe
 * rows framed by *technical mechanism*; the UI re-groups them into a
 * handful of user-facing "is this OK?" cards (one root cause = one
 * prominent card) plus a collapsed "System info" panel for the
 * info-only probes (serial / ports / first-boot / health-check
 * coverage) that aren't really problems.
 *
 * The grouping lives here (not the frontend) so every diagnose surface
 * — the wizard, /setup self-test, the MCP `diagnose` tool — sees the
 * same cards without each re-deriving the mapping. A probe with no
 * mapping falls back to `other` so a newly-added probe is never
 * silently dropped from the UI.
 */
export type ProbeGroup =
  | 'services'        // is everything running?
  | 'reverse-proxy'   // routes reach a real backend
  | 'proxy-admin'     // NPM admin auth healthy
  | 'domains'         // domains reachable
  | 'dns-network'     // DNS / LAN routing
  | 'tls'             // certificates
  | 'sso'             // login / SSO
  | 'storage-backups' // disk + backup target
  | 'system-info'     // info-only, collapsed (not a "problem")
  | 'other';          // unmapped fallback

/** Probe id → problem-domain card. Drives the UI grouping (#1534).
 *  A single root cause (a crashed service) lands every mechanism row
 *  (`podman`/`pods`/`failed_units`/`crash_loop`/`post_deploy_failed`)
 *  in the one "Services running" card so it reads as one issue. */
const PROBE_GROUP: Record<string, ProbeGroup> = {
  // Services running
  agent: 'services',
  podman: 'services',
  pods: 'services',
  failed_units: 'services',
  crash_loop: 'services',
  post_deploy_failed: 'services',
  // Reverse-proxy routes
  dangling_proxy: 'reverse-proxy',
  // Proxy admin reachable
  npm_data_stale: 'proxy-admin',
  // Domains reachable
  domain_unreachable: 'domains',
  // DNS & network routing
  lan_ip_changed_since_install: 'dns-network',
  router_dns_not_pointing: 'dns-network',
  adguard_rewrites_missing: 'dns-network',
  domain_resolves_to_box: 'dns-network',
  // TLS certificates
  cert_expiry: 'tls',
  // Login / SSO
  sso_verify: 'sso',
  // Maintenance-chat assistant (Hermes)
  hermes_chat: 'services',
  // Storage & backups
  disk: 'storage-backups',
  nas_backup_reachable: 'storage-backups',
  // System info (collapsed — not a problem)
  serial: 'system-info',
  ports: 'system-info',
  first_boot: 'system-info',
  health_checks: 'system-info',
};

/** Map a probe id to its problem-domain group, defaulting unmapped
 *  probes to `other` so a new probe is still rendered (just outside
 *  the curated cards) rather than dropped. */
export function groupForProbe(id: string): ProbeGroup {
  return PROBE_GROUP[id] ?? 'other';
}

export interface DiagnoseProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
  hint?: string;
  /**
   * Problem-domain card this probe belongs to (#1534). Populated by
   * `runDiagnose` from the `PROBE_GROUP` map; the UI buckets rows into
   * cards by this field and renders the `system-info` group collapsed.
   */
  group?: ProbeGroup;
  /**
   * Fix-buttons the UI renders next to this probe's status. Populated
   * automatically from the probe-action registry (see
   * `src/lib/diagnose/actions.ts`). Empty array when the probe has no
   * registered actions — UI shows status + hint only.
   */
  actions?: ProbeAction[];
  /**
   * Per-item rows for probes that surface multiple targets (#251 —
   * e.g. dangling proxy routes, expired certificates). Each item
   * declares which probe-level action ids apply to it; the diagnose
   * route resolves those to full ProbeAction objects in `actions`.
   * Probes can populate `_items` with raw `ProbeItem[]`; the route
   * runs `resolveItemActions` and exposes the result as `items` to
   * the wire / UI. The internal field uses an underscore so it
   * doesn't get mistaken for the resolved shape.
   */
  _items?: ProbeItem[];
  items?: ResolvedProbeItem[];
  /**
   * Persisted result history for this probe (#1541), read back from the
   * HealthStore after the run's results are side-written. Uniform across
   * every probe so the UI renders the same first-seen / last-ok / trend
   * badge on each row. Absent on a probe with no persisted results yet.
   */
  history?: ProbeHistory;
}

/** Attach the persisted-history badge (#1541) to each resolved probe.
 *  Runs *after* `persistDiagnoseResults` so the current run's result is
 *  already in the store and counts toward the trend / last-ok. A probe
 *  whose history can't be read (none yet, flaky disk) simply ships
 *  without the field — the UI degrades to status + detail. */
/**
 * True when a `podman ps` Status string shows the container is CURRENTLY
 * long-stable — `Up` for a minute or longer. Used to suppress the cumulative-
 * RestartCount crash-loop signal: a high lifetime restart count on a container
 * that has since been up for hours is historical, not an active loop
 * (#crash-loop-cumulative). Defined as "starts with `Up` and is NOT measured in
 * seconds" — which covers podman's `Up 44 hours`, `Up 2 days`, `Up 5 minutes`,
 * `Up About a minute`, `Up About an hour` while excluding `Up <N> seconds`,
 * `Up Less than a second`, and the non-`Up` states (`Restarting…`, `Exited…`,
 * `Created`) — a genuinely-looping container is always one of those. Exported
 * for unit testing.
 */
export function isContainerCurrentlyStable(status: string): boolean {
  const s = status.trim();
  if (!/^Up\b/i.test(s)) return false; // Restarting / Exited / Created → not stable
  if (/^Up\s+Less than a second/i.test(s)) return false;
  if (/^Up\s+\d+\s+seconds?\b/i.test(s)) return false; // Up N seconds → not yet stable
  return true; // Up minutes / hours / days / About a minute / About an hour
}

/**
 * True when a container's RestartCount marks it as an ACTIVE restart loop.
 * RestartCount is CUMULATIVE/monotonic, so a container that crashed a few times
 * early on but has since been `Up` for hours is NOT looping now (the real
 * solaris-tts-bridge case: RestartCount=24 yet Up 44h, ExitCode 0 — a false
 * "restart loop"). So a count at/over the threshold only counts as a loop when
 * the container isn't currently long-stable. A genuinely-looping container
 * (Authelia's #622 had 13,801) is Restarting/freshly-up, never long-stable, so it
 * still fires. A non-numeric count never trips. Exported for unit testing.
 */
export function restartCountIndicatesLoop(restartCount: number, status: string, threshold: number): boolean {
  return Number.isFinite(restartCount) && restartCount >= threshold && !isContainerCurrentlyStable(status);
}

function withHistory(probes: DiagnoseProbe[]): DiagnoseProbe[] {
  return probes.map(p => {
    const history = buildProbeHistory(p.id);
    return history ? { ...p, history } : p;
  });
}

/** Attach registry-known actions to a probe. Called once per probe in
 *  the diagnose route. Probes whose status is `ok` skip actions to
 *  avoid noisy "fix it" buttons next to passing checks.
 *
 *  When the probe has `_items`, action ids referenced by any item are
 *  treated as per-item-only and excluded from the probe-level
 *  `actions` list — otherwise the same button shows up twice (once at
 *  the probe header, once per row). Probes that want both behaviors
 *  should register two distinct actions. */
function withActions(probe: DiagnoseProbe): DiagnoseProbe {
  let perItemActionIds: Set<string> | null = null;
  if (probe._items) {
    perItemActionIds = new Set(probe._items.flatMap(i => i.actionIds));
    const items = resolveItemActions(probe.id, probe._items);
    probe = { ...probe, items };
    // Strip the unresolved shape so we don't ship duplicate data.
    delete (probe as { _items?: ProbeItem[] })._items;
  }
  if (probe.status === 'ok') return probe;
  const actions = actionsForProbe(probe.id).filter(a => !perItemActionIds?.has(a.id));
  return actions.length > 0 ? { ...probe, actions } : probe;
}

interface ExecResult {
  code?: number;
  stdout?: string;
  stderr?: string;
}

const trimOutput = (s: string | undefined, maxLines = 20): string => {
  const text = (s ?? '').trim();
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… (+${lines.length - maxLines} more lines)`].join('\n');
};

export interface DiagnoseResult {
  node: string;
  probes: DiagnoseProbe[];
}

/** Options for a diagnose run. `manual` distinguishes an operator-triggered
 *  re-run (the health-page "Run" button) from a scheduled tick — it threads
 *  into "reader" probes over expensive checks (e.g. `sso_verify`, #1709) so a
 *  manual re-run actually re-executes instead of re-displaying the cache. */
export interface RunDiagnoseOptions {
  manual?: boolean;
}

/** Build the consolidated `sso_verify` ("Login / SSO") probe row
 *  (#1455 + #1535).
 *
 *  Two layers in one row:
 *    - **headline**: live OIDC reachability (`oidc_provider_reachable`) —
 *      the cheap per-tick "does Authelia answer `/.well-known`" check.
 *      A broken provider is the most urgent failure (every SSO-gated
 *      service is 502-ing), so when it's down its status + cause drive
 *      the row.
 *    - **detail**: the persisted end-to-end login report (`checkSsoVerify`)
 *      with per-domain rows; the on-demand "Run SSO check" action re-runs
 *      it (no per-tick ephemeral-user spin).
 *
 *  All remediation actions (run_now, show_recent_logs, restart_authelia)
 *  resolve under the canonical `sso_verify` probe id.
 *
 *  Extracted from the orchestrator so the try/catch + merge shape doesn't
 *  add to `runDiagnose`'s already-large complexity budget. */
async function buildSsoVerifyProbe(nodeName: string, manual: boolean): Promise<DiagnoseProbe> {
  try {
    const [oidc, sso] = await Promise.all([
      checkOidcProviderReachable(nodeName).catch((e): Awaited<ReturnType<typeof checkOidcProviderReachable>> => ({
        status: 'info',
        detail: `OIDC reachability check skipped: ${e instanceof Error ? e.message : String(e)}`,
      })),
      // #1709: a manual re-run actually re-verifies (real verifySso, persist
      // fresh report); a scheduled tick reads the stored report only.
      checkSsoVerify({ manual, node: nodeName }),
    ]);
    const rank = { ok: 0, info: 0, warn: 1, fail: 2 } as const;
    // OIDC-provider-down outranks an SSO-report finding: if Authelia
    // can't answer discovery, the end-to-end report is moot.
    const status: ProbeStatus = rank[oidc.status] >= rank[sso.status] ? oidc.status : sso.status;
    const detailParts: string[] = [];
    if (oidc.status === 'warn' || oidc.status === 'fail') detailParts.push(`OIDC provider: ${oidc.detail}`);
    detailParts.push(sso.detail);
    return {
      id: 'sso_verify',
      label: 'Login / SSO',
      status,
      detail: detailParts.join(' · '),
      // OIDC's category hint (config/ldap/storage recovery) wins when the
      // provider is down, since that's the actionable failure.
      hint: (oidc.status === 'warn' || oidc.status === 'fail') ? (oidc.hint ?? sso.hint) : sso.hint,
      _items: sso.items,
    };
  } catch (e) {
    return {
      id: 'sso_verify',
      label: 'Login / SSO',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Run the diagnose probe battery against `nodeName`. Pure orchestrator —
 *  the route returns this verbatim under NextResponse.json. */
export async function runDiagnose(nodeName: string = 'Local', opts: RunDiagnoseOptions = {}): Promise<DiagnoseResult> {
  const manual = opts.manual ?? false;
  const probes: DiagnoseProbe[] = [];
  const exec = async (command: string, timeoutMs = 8000): Promise<ExecResult> => {
    try {
      const agent = await agentManager.ensureAgent(nodeName);
      const result = await agent.sendCommand('exec', { command }, { timeoutMs });
      return result as ExecResult;
    } catch (e) {
      return { code: -1, stderr: e instanceof Error ? e.message : String(e) };
    }
  };

  // 1) Agent reachability — implicit in everything else, but check first.
  const ping = await exec('echo agent-ok', 4000);
  probes.push({
    id: 'agent',
    label: 'Agent reachable',
    status: ping.code === 0 ? 'ok' : 'fail',
    detail: ping.code === 0 ? 'SSH agent responded.' : (ping.stderr || 'No response'),
    hint: ping.code === 0 ? undefined : 'Check Settings → Nodes that the SSH URI + key are correct, and that the host is reachable.',
  });

  if (ping.code !== 0) {
    // Agent unreachable — only the `agent` probe ran. Resolve + persist
    // it on the same path the full run uses (#1540) so its history keeps
    // accruing even while the box is down.
    const resolved = probes.map(withActions).map(p => ({ ...p, group: groupForProbe(p.id) }));
    persistDiagnoseResults(resolved);
    return { node: nodeName, probes: withHistory(resolved) };
  }

  // Probes 2-9 each shell out to the agent independently. Earlier
  // versions awaited them sequentially, which made the total wait
  // ~the sum of every probe's timeout (worst-case ~30s on a slow
  // agent). Fanning them out via Promise.all collapses the wall-clock
  // to ~the slowest single probe (~5s) while preserving the rest of
  // the inline analysis as straight-line code.
  //
  // Probe 9 (crash_loop) needs uptime + ps for its analysis but the
  // per-container log fetches (already a Promise.all) stay deferred
  // because they depend on which containers `podman ps` flags as
  // looping.
  const [
    podmanInfo,
    pods,
    failed,
    listen,
    serial,
    disk,
    firstBoot,
    uptimeRes,
    psStatus,
  ] = await Promise.all([
    exec('podman info --format "{{.Host.Arch}} {{.Host.OS}} {{.Version.Version}}"', 4000),
    exec('podman pod ps --format "{{.Name}}|{{.Status}}|{{.NumberOfContainers}}"', 5000),
    exec('systemctl --user --failed --no-legend --no-pager 2>&1', 5000),
    exec('ss -ltn 2>/dev/null | tail -n +2 | awk \'{print $4}\' | awk -F: \'{print $NF}\' | sort -nu', 4000),
    exec('ls -la /dev/serial/by-id/ 2>/dev/null | grep -v "^total" | awk \'{print $NF}\' | grep -v "^$"', 3000),
    exec('df -h /mnt/data 2>/dev/null | tail -1', 3000),
    exec(
      'systemctl --no-pager status setup-raid install-python install-nginx 2>&1 | grep -E "(●|Active:)" | head -20',
      5000,
    ),
    exec('cat /proc/uptime 2>/dev/null', 1500),
    // `{{.RestartCount}}` is wired in alongside Names + Status because
    // the Status-string heuristics below ("Up <30s", "Restarting") miss
    // the case a container restarts every ~150 ms and `podman ps` keeps
    // catching it during the up-phase. RestartCount is monotonic — a
    // value > a small threshold means the container has crashed many
    // times since its current podman db generation, regardless of how
    // "up" it looks right now. Caught the Authelia 13,801-restart
    // silent-fail (#622).
    //
    // #661 — keep stderr visible (no `2>/dev/null`) and match the 5s
    // timeout of the pods probe. Previously the probe silenced stderr,
    // then on non-zero exit reported a bare "podman ps failed" with no
    // detail — directly contradicting the Pods probe above which uses
    // the same engine. Now operators see the actual error text.
    // The field was renamed from `RestartCount` to `Restarts` in
    // podman 5.8 (Fedora 44 ships 5.8.1). The old name crashes the
    // template render with "can't evaluate field RestartCount in
    // type containers.psReporter" — every diagnose run shows a fake
    // "podman ps exit=125" failure on FCoS 44+.
    exec('podman ps --format "{{.Names}}|{{.Status}}|{{.Restarts}}"', 5000),
  ]);

  // 2) Container engine
  probes.push({
    id: 'podman',
    label: 'Podman engine',
    status: podmanInfo.code === 0 ? 'ok' : 'fail',
    detail: podmanInfo.code === 0 ? `podman ${trimOutput(podmanInfo.stdout)}` : (podmanInfo.stderr || 'podman not responding'),
    hint: podmanInfo.code === 0 ? undefined : 'Run `systemctl --user enable --now podman.socket` on the node.',
  });

  // 3) Running pods — one item per non-running pod with a per-row Start
  //    action (per podsAndEngine.ts). Pods whose containers crash-loop
  //    are surfaced separately by the crash_loop probe with their own
  //    actions; this row catches the pod-level "Created/Exited" cases.
  const podLines = trimOutput(pods.stdout, 30).split('\n').filter(Boolean);
  const failedPods = podLines.filter(l => !/Running/i.test(l.split('|')[1] ?? ''));
  const podItems: ProbeItem[] = failedPods.map((line): ProbeItem | null => {
    const tokens = line.split('|');
    const name = (tokens[0] ?? '').trim();
    const podStatus = (tokens[1] ?? '').trim();
    if (!name) return null;
    return {
      id: name,
      label: name,
      detail: podStatus,
      status: 'warn' as const,
      actionIds: ['start_pod'],
    };
  }).filter((i): i is ProbeItem => i !== null);
  probes.push({
    id: 'pods',
    label: 'Pods',
    status: pods.code !== 0 ? 'fail' : (failedPods.length === 0 ? 'ok' : 'warn'),
    detail: pods.code !== 0
      ? (pods.stderr || 'podman pod ps failed')
      : (podLines.length === 0 ? 'No pods deployed yet.' : `${podLines.length} pod(s): ${podLines.length - failedPods.length} running, ${failedPods.length} not running.`),
    hint: failedPods.length > 0 ? 'Click "Start" on a row to bring the pod back up. If individual containers are crash-looping, the crash_loop probe below has per-container actions.' : undefined,
    _items: podItems.length > 0 ? podItems : undefined,
  });

  // 4) Failed user services
  // Some unit failures are first-boot artefacts that no longer reflect a
  // problem the operator can act on:
  //
  //   * install-nginx.service — first-boot oneshot that waits for the
  //     ServiceBay agent + auto-installs NPM if the wizard hasn't already.
  //     If the wizard finished first, the agent typically hadn't connected
  //     yet so the script gives up after its timeout and stays `failed`
  //     forever (Type=oneshot doesn't reset on subsequent boots). NPM is
  //     happily running by then. Surface it once with a "benign" note
  //     instead of nagging on every probe run.
  //   * podman healthcheck per-instance units — names look like
  //     `<sha>-<sha>.service` and bubble up when a container reports an
  //     unhealthy probe; the *container* state is already covered by the
  //     crash_loop probe below, so flagging the wrapper unit too is
  //     duplicative.
  const failedRaw = trimOutput(failed.stdout, 30).split('\n').filter(Boolean);
  const isBenignFailedUnit = (line: string) =>
    /\binstall-nginx\.service\b/.test(line) ||
    /^●\s*[0-9a-f]{40,}-[0-9a-f]+\.service\b/i.test(line.trim());
  const benign = failedRaw.filter(isBenignFailedUnit);
  const realFailed = failedRaw.filter(l => !isBenignFailedUnit(l));
  const detail = (() => {
    if (realFailed.length === 0 && benign.length === 0) return 'No failed user units.';
    if (realFailed.length === 0) return `0 actionable failures (${benign.length} benign first-boot leftover ignored).`;
    return `${realFailed.length} failed unit(s)${benign.length ? ` (+${benign.length} benign first-boot leftovers ignored)` : ''}.`;
  })();
  // Parse each failed line into { name, description } for items[].
  // `systemctl --failed --no-legend` output is like:
  //   ● my-svc.service           loaded failed failed Description text here
  // Whitespace-split → name is index 1, description starts at index 5.
  const failedUnitItems: ProbeItem[] = realFailed.map((line): ProbeItem | null => {
    const tokens = line.trim().replace(/^●\s*/, '').split(/\s+/);
    const name = tokens[0];
    if (!name) return null;
    const desc = tokens.slice(4).join(' ').trim();
    return {
      id: name,
      label: name,
      detail: desc || 'failed',
      status: 'warn' as const,
      actionIds: ['restart_unit', 'reset_failed'],
    };
  }).filter((i): i is ProbeItem => i !== null);
  probes.push({
    id: 'failed_units',
    label: 'systemd user units',
    status: realFailed.length === 0 ? 'ok' : 'warn',
    detail,
    hint: realFailed.length > 0
      ? 'Click "Restart" to retry a failed unit, or "Clear failed state" if the underlying cause is already fixed and you just want the dashboard to stop nagging.'
      : undefined,
    _items: failedUnitItems.length > 0 ? failedUnitItems : undefined,
  });

  // 5) Listening ports — only flag ones that don't map to a running
  //    service or a standard system port. Dumping all 30 open ports
  //    in the detail string was noise; the operator just installed
  //    those services and knows nginx listens on 80. Show count +
  //    any actual surprise ports with their owning container/service
  //    so the operator doesn't have to cross-reference manually.
  //    See `lib/diagnose/portsProbe.ts` for the source-walk helpers.
  const ports = trimOutput(listen.stdout, 50).split('\n').filter(Boolean);
  const portsTwin = getNodeTwin(nodeName);
  const portSource = buildPortSourceMap(
    portsTwin?.services as TwinPortService[] | undefined,
    portsTwin?.containers as TwinPortContainer[] | undefined,
  );
  const unexpected = ports.filter(p => {
    const n = parseInt(p, 10);
    return !Number.isFinite(n) || !portSource.has(n);
  });
  probes.push({
    id: 'ports',
    label: 'Open TCP ports',
    status: ports.length === 0 ? 'warn' : (unexpected.length === 0 ? 'ok' : 'info'),
    detail: ports.length === 0
      ? 'No ports detected — services may still be starting.'
      : unexpected.length === 0
        ? `${ports.length} ports listening, all match installed services or standard system ports.`
        : `${ports.length} ports listening; ${unexpected.length} not mapped to a known service: ${unexpected.map(p => renderUnexpectedPort(p, portSource)).join(', ')}.`,
  });

  // 6) USB serial devices (Z-Wave / Zigbee sticks)
  const serialDevices = trimOutput(serial.stdout, 20).split('\n').filter(Boolean);
  probes.push({
    id: 'serial',
    label: 'USB serial devices',
    status: serialDevices.length > 0 ? 'ok' : 'info',
    detail: serialDevices.length === 0 ? 'No USB serial devices (no Z-Wave / Zigbee stick plugged in).' : serialDevices.join('\n'),
  });

  // 7) Disk usage on /mnt/data (where ServiceBay stores everything)
  const diskLine = trimOutput(disk.stdout, 1);
  let diskStatus: ProbeStatus = 'ok';
  let diskHint: string | undefined;
  const usePctMatch = diskLine.match(/(\d+)%/);
  if (!diskLine) {
    diskStatus = 'warn';
    diskHint = '/mnt/data is not mounted yet — first-boot RAID setup may still be running.';
  } else if (usePctMatch) {
    const used = parseInt(usePctMatch[1], 10);
    if (used >= 90) {
      diskStatus = 'warn';
      diskHint = 'Storage above 90% — click "Show largest directories" below to find what to clean, or extend the array.';
    }
  }
  probes.push({
    id: 'disk',
    label: 'Storage (/mnt/data)',
    status: diskStatus,
    detail: diskLine || 'no df output',
    hint: diskHint,
  });

  // 8) First-boot oneshot units (FCOS only)
  const fbLines = trimOutput(firstBoot.stdout, 20).split('\n').filter(Boolean);
  const fbStuck = fbLines.some(l => /activating/i.test(l));
  probes.push({
    id: 'first_boot',
    label: 'First-boot setup units',
    status: fbLines.length === 0 ? 'info' : (fbStuck ? 'warn' : 'ok'),
    detail: fbLines.length === 0 ? 'Not an FCOS install (no first-boot units).' : fbLines.join('\n'),
    hint: fbStuck ? 'A first-boot unit is still activating after a long time. SSH into the host and run `journalctl -u <unit-name>` for details.' : undefined,
  });

  // 9) Containers in a restart loop. Heuristic on `Status` from podman ps:
  //    "Restarting", "Initialized (starting)", or "Up <30s" while we'd
  //    expect long-running services. Catches the bind-mount permission
  //    crash-loops + entrypoint argv mistakes that bit us before 3.1.3.
  //
  //    Gate the "Up <30s" rule behind system uptime: if the host itself has
  //    only been up for ~a minute, every container is naturally young — they
  //    can't have been up *longer* than the kernel. Auto-running the probe
  //    right after first boot used to flag every fresh container as
  //    "may be in a restart loop" purely because it had only just started.
  const systemUptimeSec = (() => {
    const first = (uptimeRes.stdout ?? '').trim().split(/\s+/)[0];
    const n = parseFloat(first);
    return Number.isFinite(n) ? Math.floor(n) : Number.POSITIVE_INFINITY;
  })();
  // Containers up for less than (system uptime - this margin) are genuinely
  // restarting; younger ones are just "started at boot, not looping". 90 s
  // covers the slowest cold-start + a tiny grace window.
  const recentBootGrace = 90;
  // Same suppression after an install: the /setup auto-diagnose fires
  // the moment a job lands in `done`, by which point the fresh
  // containers are 30-90 s old and would all trip the "Up <30s" rule.
  // System uptime is past `recentBootGrace` by then (FCoS booted
  // hours ago), so the boot-time gate doesn't help. Five minutes is
  // wide enough for the slowest first-boot install path (image pulls
  // + post-deploy seeds + the operator clicking "Finish") to settle.
  const RECENT_INSTALL_GRACE_MS = 5 * 60_000;
  const recentInstall = await wasInstallActiveWithin(RECENT_INSTALL_GRACE_MS);
  const treatYoungAsLoop = systemUptimeSec > recentBootGrace && !recentInstall;

  const psLines = trimOutput(psStatus.stdout, 80).split('\n').filter(Boolean);
  // RestartCount > this is treated as a definite restart loop regardless
  // of how "up" the container looks right now. Threshold deliberately
  // small: a healthy long-lived container is 0; sporadic OOM-kill
  // recovery is 1–2; anything >= 3 since podman's last db generation
  // means something is consistently failing. Authelia in the #622 bug
  // had 13,801 — even with the recent-install grace suppressing the
  // status-string heuristics, this would have fired.
  const RESTART_COUNT_LOOP_THRESHOLD = 3;
  const looping = psLines.filter(l => {
    const parts = l.split('|');
    const status = (parts[1] ?? '').trim();
    const restartCountRaw = (parts[2] ?? '').trim();
    const restartCount = parseInt(restartCountRaw, 10);
    // Restart-count check first — it's the only signal that survives
    // the status-string heuristics' boot/install grace window. (The CUMULATIVE-
    // count vs current-stability nuance lives in restartCountIndicatesLoop.)
    if (restartCountIndicatesLoop(restartCount, status, RESTART_COUNT_LOOP_THRESHOLD)) return true;
    if (/^Restarting/i.test(status)) return true;
    if (/^Initialized/i.test(status)) return true;
    // Only flag "Up <30s" when the system has been up long enough that a
    // young container *must* be a fresh restart — see comment above.
    if (!treatYoungAsLoop) return false;
    if (/^Up Less than a second/i.test(status)) return true;
    const m = status.match(/^Up (\d+) seconds?\b/);
    if (m && parseInt(m[1], 10) < 30) return true;
    return false;
  });
  // Pull the actual crash reason for each restart-looping container instead
  // of leaving the operator to run `podman logs <name>` by hand. Three lines
  // of stderr is usually enough to identify the failure mode (chmod EPERM,
  // missing config file, port collision, etc). Best-effort: if a fetch fails
  // we just omit that container's snippet.
  const offenderDiagnostics = await Promise.all(
    looping.map(async line => {
      const name = (line.split('|')[0] ?? '').trim();
      if (!name) return { line, snippet: '' };
      const logs = await exec(`podman logs --tail 3 ${name} 2>&1 | tail -3`, 3000);
      const snippet = (logs.stdout ?? '').trim();
      return { line, snippet };
    }),
  );
  // Build per-container items so the UI can attach Restart / Show
  // recent logs actions to each looping container individually
  // (B15 / #251 items[] schema).
  const crashLoopItems: ProbeItem[] = offenderDiagnostics.map((o): ProbeItem => {
    const parts = o.line.split('|');
    const name = (parts[0] ?? '').trim();
    const podmanStatus = (parts[1] ?? '').trim();
    const restartCountRaw = (parts[2] ?? '').trim();
    const restartCount = parseInt(restartCountRaw, 10);
    const restartTag = Number.isFinite(restartCount) && restartCount > 0
      ? ` (RestartCount=${restartCount})`
      : '';
    const detailHead = `${podmanStatus}${restartTag}`;
    return {
      id: name,
      label: name,
      detail: o.snippet ? `${detailHead} — ${o.snippet.split('\n').slice(-2).join(' | ')}` : detailHead,
      status: 'warn',
      actionIds: ['restart_pod', 'show_recent_logs'],
    };
  }).filter(item => item.id);

  probes.push({
    id: 'crash_loop',
    label: 'Containers stable',
    status: psStatus.code !== 0 ? 'warn' : (looping.length === 0 ? 'ok' : 'warn'),
    detail: psStatus.code !== 0
      ? `podman ps exit=${psStatus.code}${psStatus.stderr ? ` — ${psStatus.stderr.trim()}` : ''}`
      : (psLines.length === 0
          ? 'No running containers yet.'
          : looping.length === 0
            ? (treatYoungAsLoop
                ? `${psLines.length} container(s), all stable.`
                : recentInstall
                    ? `${psLines.length} container(s) — install just finished, young containers expected. Re-run after ~5 min for a real restart-loop check.`
                    : `${psLines.length} container(s) — system booted ${systemUptimeSec}s ago, young containers expected. Re-run after ~2 min for a real restart-loop check.`)
            : `${looping.length} of ${psLines.length} container(s) may be in a restart loop.`),
    hint: looping.length > 0
      ? 'Each row shows the last log lines from the container. Click "Restart" after fixing the root cause (bind-mount perms, missing config, port conflict). "Show recent logs" pulls the last 5 lines for a quick triage without SSH.'
      : undefined,
    _items: crashLoopItems.length > 0 ? crashLoopItems : undefined,
  });

  // 10) Health-check coverage. After a few minutes since boot every enabled
  //     check should have a lastResult. A backlog of `lastResult: null`
  //     means the scheduler is wedged or a runner type is broken (this was
  //     the case before 3.1.3 — saveCheck didn't notify the scheduler).
  try {
    const checks = HealthStore.getChecks();
    const enabled = checks.filter(c => c.enabled !== false);
    const STALE_MIN_AGE_MS = 2 * 60_000;
    const stale = enabled.filter(c => {
      const lastResult = HealthStore.getLastResult(c.id);
      if (lastResult) return false;
      const created = c.created_at ? Date.parse(c.created_at) : 0;
      return created > 0 && (Date.now() - created) > STALE_MIN_AGE_MS;
    });
    probes.push({
      id: 'health_checks',
      label: 'Health-check coverage',
      status: enabled.length === 0 ? 'info' : (stale.length === 0 ? 'ok' : 'warn'),
      detail: enabled.length === 0
        ? 'No health checks configured.'
        : stale.length === 0
          ? `All ${enabled.length} enabled check(s) have run at least once.`
          : `${stale.length} of ${enabled.length} enabled check(s) older than 2 min haven't produced a result yet:\n${stale.map(c => `  ${c.name} (${c.type})`).join('\n')}`,
      hint: stale.length > 0
        ? 'Open Settings → Health → Run all to force a tick. If they still fail, the runner type may be broken — check journalctl for "[Health]" errors.'
        : undefined,
    });
  } catch (e) {
    probes.push({
      id: 'health_checks',
      label: 'Health-check coverage',
      status: 'info',
      detail: `Could not read checks store: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 11) Network-map dangling proxy routes — NPM forwards traffic to a
  //     host:port that no managed service or running container actually
  //     publishes. Surfaces stale routes from removed/renamed services
  //     and crash-failed services that NPM still has a path to.
  //
  //     #251: each dangling route is exposed as a `ProbeItem` so the UI
  //     can show one row per route with a per-item "Delete route"
  //     action. The action handler lives in
  //     `lib/diagnose/probes/danglingProxy.ts` (registers
  //     `delete_route`).
  try {
    const twin = getNodeTwin(nodeName);
    type ProxyServer = {
      _targetPort?: number;
      _id?: number;
      variable_fields?: { targetHost?: string; targetPort?: number };
      server_name?: string[];
      locations?: { proxy_pass?: string }[];
    };
    type TwinService = { ports?: { hostPort?: number; hostIp?: string }[] };
    type TwinContainer = { ports?: { hostPort?: number }[] };
    const proxyService = twin?.services?.find((s: { name?: string; proxyConfiguration?: unknown }) =>
      typeof s.proxyConfiguration === 'object' && s.proxyConfiguration !== null,
    );
    const proxyConfig = proxyService
      ? ((proxyService as { proxyConfiguration?: { servers?: ProxyServer[] } }).proxyConfiguration?.servers ?? [])
      : [];
    const nodeIPs: string[] = (twin && (twin as unknown as { nodeIPs?: string[] }).nodeIPs) || [];
    const isLocalHost = (h?: string) => !!h && (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h) || nodeIPs.includes(h));
    // Candidate ports we know are served by SOMETHING managed.
    const knownPorts = new Set<number>();
    for (const svc of (twin?.services ?? []) as TwinService[]) {
      for (const p of (svc.ports ?? [])) {
        if (typeof p.hostPort === 'number') knownPorts.add(p.hostPort);
      }
    }
    for (const c of (twin?.containers ?? []) as TwinContainer[]) {
      for (const p of (c.ports ?? [])) {
        if (typeof p.hostPort === 'number') knownPorts.add(p.hostPort);
      }
    }
    const danglingItems: ProbeItem[] = [];
    for (const server of proxyConfig) {
      const targetHost = server.variable_fields?.targetHost;
      const targetPort = server.variable_fields?.targetPort ?? server._targetPort;
      if (!targetPort || !isLocalHost(targetHost)) continue;
      // NPM has internal admin routes (e.g. 127.0.0.1:3000 → its own admin
      // backend, 127.0.0.1:80 → its own UI). Don't flag those.
      const isProxySelfRef = ['127.0.0.1', 'localhost', '::1'].includes(targetHost ?? '');
      if (isProxySelfRef) continue;
      if (!knownPorts.has(targetPort)) {
        const names = server.server_name ?? [];
        const primaryDomain = names[0];
        const label = names.join(', ') || '(unnamed)';
        if (!primaryDomain) {
          // No server_name — nothing to dispatch against. Surface as a
          // read-only row instead of skipping entirely.
          danglingItems.push({
            id: `unnamed-${targetHost}-${targetPort}`,
            label,
            detail: `→ ${targetHost}:${targetPort}`,
            status: 'warn',
            actionIds: [],
          });
          continue;
        }
        // The action handler maps domain → NPM proxy_host id at
        // dispatch time (the digital twin doesn't track NPM's primary
        // key — see danglingProxy.ts header comment).
        danglingItems.push({
          id: primaryDomain,
          label,
          detail: `→ ${targetHost}:${targetPort}`,
          status: 'warn',
          actionIds: ['delete_route'],
        });
      }
    }

    // #1535 — fold the inverse direction (routes that should exist but
    // weren't created) into the same "Reverse-proxy routes" row. Extra
    // routes get a Delete-route button; missing routes get Retry-create.
    // Both action ids resolve under the canonical `dangling_proxy` probe.
    let missingItems: ProbeItem[] = [];
    let missingCount = 0;
    try {
      const prm = await checkProxyRouteMissing();
      missingItems = prm.items ?? [];
      missingCount = missingItems.length;
    } catch (e) {
      logger.warn('diagnose:dangling_proxy', `proxy_route_missing fold-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const routeItems = [...danglingItems, ...missingItems];
    const detailParts: string[] = [];
    if (danglingItems.length) detailParts.push(`${danglingItems.length} dangling (target not served)`);
    if (missingCount) detailParts.push(`${missingCount} missing (creation failed on install)`);
    probes.push({
      id: 'dangling_proxy',
      label: 'Reverse-proxy routes',
      status: !proxyService
        ? (missingCount > 0 ? 'warn' : 'info')
        : (routeItems.length === 0 ? 'ok' : 'warn'),
      detail: !proxyService
        ? (missingCount > 0
            ? `${missingCount} proxy host(s) failed to create on install — traffic hits NPM's default 404.`
            : 'No managed reverse proxy yet (or its config is not synced to the twin).')
        : routeItems.length === 0
          ? `${proxyConfig.length} proxy route(s), all reach a known service.`
          : `${detailParts.join(' · ')}.`,
      hint: routeItems.length > 0
        ? 'Each row has a fix: "Delete route" removes a dangling NPM host (target gone); "Retry create" pushes a missing route back into NPM (most often a wrong-creds failure — see npm_data_stale).'
        : undefined,
      _items: routeItems.length > 0 ? routeItems : undefined,
    });
  } catch (e) {
    probes.push({
      id: 'dangling_proxy',
      label: 'Reverse-proxy routes',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 12) NPM admin credentials staleness — probe-action handlers
  //     attached automatically when status !== 'ok' (see withActions).
  try {
    const npmStale = await checkNpmDataStale();
    if (npmStale.status) {
      probes.push({
        id: 'npm_data_stale',
        label: 'Nginx Proxy Manager auth',
        status: npmStale.status,
        detail: npmStale.detail,
        hint: npmStale.hint,
      });
    }
  } catch (e) {
    probes.push({
      id: 'npm_data_stale',
      label: 'Nginx Proxy Manager auth',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 13) LAN-IP drift since install (D19-PR9 / #266). info / warn —
  //     surfaces when ServiceBay's current LAN IP differs from the
  //     value captured at install, or when the IP has flipped > 1
  //     time in 30 days.
  try {
    const lanIp = await checkLanIpChanged();
    probes.push({
      id: 'lan_ip_changed_since_install',
      label: 'LAN IP stability',
      status: lanIp.status,
      detail: lanIp.detail,
      hint: lanIp.hint,
    });
  } catch (e) {
    probes.push({
      id: 'lan_ip_changed_since_install',
      label: 'LAN IP stability',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 14) Router DNS routing for LAN-domain mode (D19-PR6 / #263).
  //     Detects whether household devices use AdGuard as DNS;
  //     surfaces fix-buttons (configure FritzBox via TR-064 /
  //     verify from this device / dismiss for 30 days) when not.
  try {
    const router = await checkRouterDnsNotPointing();
    probes.push({
      id: 'router_dns_not_pointing',
      label: 'Router DNS routing',
      status: router.status,
      detail: router.detail,
      hint: router.hint,
    });
  } catch (e) {
    probes.push({
      id: 'router_dns_not_pointing',
      label: 'Router DNS routing',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 14a) Core service domains resolve to the box (#1563). The blunt
  //     precondition every SSO/OIDC flow depends on: does
  //     `ldap.<publicDomain>` / `auth.<publicDomain>` / each public app
  //     domain resolve to ServiceBay's LAN IP from the box's own
  //     resolver? `domain_unreachable` bypasses DNS with a Host: header,
  //     so a node whose DNS is entirely broken (FritzBox→AdGuard upstream
  //     down, #1559) can still look green there. This probe is the
  //     blocking gate — a `fail` here means a reinstall must not be
  //     declared healthy (pairs with #1561). Fix lives on the
  //     `router_dns_not_pointing` row (Pattern A: DHCP DNS → ServiceBay).
  try {
    const dnsResolve = await checkDomainResolvesToBox();
    probes.push({
      id: 'domain_resolves_to_box',
      label: 'Service domains resolve to box',
      status: dnsResolve.status,
      detail: dnsResolve.detail,
      hint: dnsResolve.hint,
    });
  } catch (e) {
    probes.push({
      id: 'domain_resolves_to_box',
      label: 'Service domains resolve to box',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 14b) Login / SSO (#623 + #1455 + #1535 — consolidated). One row that
  //     fronts live OIDC-provider reachability (does Authelia answer
  //     `/.well-known/openid-configuration` — caught the #622 storage-key
  //     drift where every SSO-gated service 502'd while diagnose was
  //     green) and carries the persisted end-to-end login report (real
  //     family-group login reaches every user domain, is blocked from
  //     admin-only ones) with an on-demand "Run SSO check" action.
  probes.push(await buildSsoVerifyProbe(nodeName, manual));

  // 14c) Proxy route create-failures (B12) are now folded into the
  //     consolidated `dangling_proxy` ("Reverse-proxy routes") row above
  //     (#1535) — missing routes carry the same "Retry create" action.

  // 15) Post-deploy seed failures (B8 / #252). Surfaces services whose
  //     last `post-deploy.py` exited non-zero so silent seed failures
  //     don't sit there indefinitely. Each failed service is one item
  //     with per-row "Re-run post-install" + "Clear record" actions.
  try {
    const pd = await checkPostDeployFailed();
    probes.push({
      id: 'post_deploy_failed',
      label: 'Service seed steps',
      status: pd.status,
      detail: pd.detail,
      hint: pd.hint,
      _items: pd.items,
    });
  } catch (e) {
    probes.push({
      id: 'post_deploy_failed',
      label: 'Service seed steps',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 16) TLS certificates (#1535 — consolidated). One row covering both
  //     failure modes of NPM-managed Let's Encrypt certs:
  //       - expiry  (cert_expiry check): warn ≤14d / fail when expired;
  //         per-row "Renew now" action.
  //       - ACME request failure (cert_request_failure check): NPM's
  //         opaque "Internal Error" decoded from letsencrypt.log; per-row
  //         "Show log tail" + "Retry now" actions.
  //     Both checks' items merge into this row; all three actions
  //     (renew_cert, show_log_tail, retry_request) resolve under the
  //     canonical `cert_expiry` probe id.
  try {
    const [ce, crf] = await Promise.all([
      checkCertExpiry(),
      checkCertRequestFailure().catch((e): Awaited<ReturnType<typeof checkCertRequestFailure>> => ({
        status: 'info',
        detail: `request-failure check skipped: ${e instanceof Error ? e.message : String(e)}`,
      })),
    ]);
    const certItems = [...(ce.items ?? []), ...(crf.items ?? [])];
    // Status = worst of the two; an expired cert (fail) outranks a recent
    // ACME failure (warn/fail) outranks expiring-soon (warn).
    const rank = { ok: 0, info: 0, warn: 1, fail: 2 } as const;
    const worstStatus = (a: ProbeStatus, b: ProbeStatus): ProbeStatus =>
      rank[a] >= rank[b] ? a : b;
    const status = worstStatus(ce.status, crf.status);
    const detailParts: string[] = [];
    if (ce.status !== 'info' && ce.status !== 'ok') detailParts.push(ce.detail);
    if (crf.status !== 'info' && crf.status !== 'ok') detailParts.push(crf.detail);
    if (detailParts.length === 0) detailParts.push(ce.status === 'ok' ? ce.detail : crf.detail);
    probes.push({
      id: 'cert_expiry',
      label: 'TLS certificates',
      status,
      detail: detailParts.join(' '),
      hint: ce.hint ?? crf.hint,
      _items: certItems.length > 0 ? certItems : undefined,
    });
  } catch (e) {
    probes.push({
      id: 'cert_expiry',
      label: 'TLS certificates',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 17) AdGuard DNS rewrites. The portal provisioner is fire-and-forget
  //     at install + 60s after boot; either invocation can silently
  //     fail (AdGuard cold-starting, auth flapping). This probe is the
  //     safety net — it diffs AdGuard's current rewrite list against
  //     the expected set and offers a one-click "Reprovision" that
  //     re-runs the same code path.
  try {
    const ar = await checkAdguardRewritesMissing();
    probes.push({
      id: 'adguard_rewrites_missing',
      label: 'AdGuard DNS rewrites',
      status: ar.status,
      detail: ar.detail,
      hint: ar.hint,
    });
  } catch (e) {
    probes.push({
      id: 'adguard_rewrites_missing',
      label: 'AdGuard DNS rewrites',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 18) Config-backup NAS reachability (#1224). Surfaces a silently-broken
  //     backup target — the FritzBox had file sharing off during #1190
  //     verification, so backups never landed and nobody knew until a
  //     reinstall needed them. info when no NAS is configured.
  try {
    const nas = await checkNasBackupReachable();
    probes.push({
      id: 'nas_backup_reachable',
      label: 'Config backup (FritzBox NAS)',
      status: nas.status,
      detail: nas.detail,
      hint: nas.hint,
    });
  } catch (e) {
    probes.push({
      id: 'nas_backup_reachable',
      label: 'Config backup (FritzBox NAS)',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 18b) Home Assistant automation/script/scene integrity (#1864). Surfaces
  //      the data-loss fingerprint — the entity registry references N>0
  //      automations but their config file parses to 0 entries — as a warn,
  //      and warns when HA owns automations but no EFFECTIVE backup target
  //      (gateway-or-externalBackup) resolves to recover from.
  try {
    const hai = await checkHaAutomationIntegrity(nodeName);
    probes.push({
      id: 'ha_automation_integrity',
      label: 'Home Assistant automations integrity',
      status: hai.status,
      detail: hai.detail,
      hint: hai.hint,
    });
  } catch (e) {
    probes.push({
      id: 'ha_automation_integrity',
      label: 'Home Assistant automations integrity',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 19) Maintenance-chat assistant (Hermes) reachability (#1761). Crucially
  //     distinguishes an API-KEY MISMATCH (Hermes 401 — ServiceBay's stored
  //     key drifted from the externally-deployed engine's API_SERVER_KEY)
  //     from a genuine outage, and offers a one-click "Reconcile Hermes API
  //     key" heal-action so the operator repairs drift without a reinstall.
  try {
    const hc = await checkHermesChat();
    probes.push({
      id: 'hermes_chat',
      label: 'Maintenance chat (Hermes)',
      status: hc.status,
      detail: hc.detail,
      hint: hc.hint,
    });
  } catch (e) {
    probes.push({
      id: 'hermes_chat',
      label: 'Maintenance chat (Hermes)',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Domains reachable (#1535 — consolidated). One row covering both
  // directions of "can this domain be reached":
  //   - headline: cheap per-domain fetch+DNS diagnosis (LAN + public),
  //     each broken domain a row with the matching inline fix action
  //     (retry_create / reprovision / show DNS instructions).
  //   - deep check: the slow DoH + letsdebug external view, demoted from
  //     an always-listed second probe to per-row "Refresh DNS check" /
  //     "Run letsdebug" actions (run on demand, letsdebug rate-limited).
  // External rows merge into the same row; a domain present in both
  // directions keeps one row with the union of its fix actions.
  try {
    const [du, dr] = await Promise.all([
      checkDomainUnreachable(),
      checkDomainExternalReachability().catch((e): Awaited<ReturnType<typeof checkDomainExternalReachability>> => ({
        status: 'info',
        detail: `external reachability check skipped: ${e instanceof Error ? e.message : String(e)}`,
      })),
    ]);
    const byDomain = new Map<string, ProbeItem>();
    for (const it of [...(du.items ?? []), ...(dr.items ?? [])]) {
      const existing = byDomain.get(it.id);
      if (!existing) {
        byDomain.set(it.id, { ...it, actionIds: [...it.actionIds] });
      } else {
        // Same domain from both directions — merge the detail + the
        // union of fix actions onto a single row; keep the worst status.
        existing.detail = [existing.detail, it.detail].filter(Boolean).join('\n');
        for (const a of it.actionIds) if (!existing.actionIds.includes(a)) existing.actionIds.push(a);
        if (it.status === 'fail' || (it.status === 'warn' && existing.status === 'info')) existing.status = it.status;
      }
    }
    const domainItems = Array.from(byDomain.values());
    const rank = { ok: 0, info: 0, warn: 1, fail: 2 } as const;
    const status: ProbeStatus = rank[du.status] >= rank[dr.status] ? du.status : dr.status;
    const detailParts: string[] = [];
    if (du.status !== 'ok' && du.status !== 'info') detailParts.push(du.detail);
    if (dr.status !== 'ok' && dr.status !== 'info') detailParts.push(`External: ${dr.detail}`);
    if (detailParts.length === 0) detailParts.push(du.status !== 'info' ? du.detail : dr.detail);
    probes.push({
      id: 'domain_unreachable',
      label: 'Domains reachable',
      status,
      detail: detailParts.join(' · '),
      hint: du.hint ?? dr.hint,
      _items: domainItems.length > 0 ? domainItems : undefined,
    });
  } catch (e) {
    probes.push({
      id: 'domain_unreachable',
      label: 'Domains reachable',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const resolved = probes.map(withActions).map(p => ({ ...p, group: groupForProbe(p.id) }));
  // #1540 — side-write every probe's result to the HealthStore so the
  // ~16 stateless inline probes accrue history on every on-demand run
  // (wizard / /setup self-test / MCP diagnose), not just the daily
  // scheduler. On-demand behaviour is unchanged: this is a fire-side
  // write of the already-computed results (saveResult logs-but-never-
  // throws on a write error).
  persistDiagnoseResults(resolved);
  // #1541 — read the just-persisted history back so every probe carries a
  // uniform first-seen / last-ok / trend badge for the UI.
  return {
    node: nodeName,
    probes: withHistory(resolved),
  };
}
