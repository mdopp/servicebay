import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { HealthStore } from '@/lib/health/store';
import { DigitalTwinStore } from '@/lib/store/twin';
import { actionsForProbe, resolveItemActions, type ProbeAction, type ProbeItem, type ResolvedProbeItem } from '@/lib/diagnose/actions';
import { checkNpmDataStale } from '@/lib/diagnose/probes/npmDataStale';
import { checkLanIpChanged } from '@/lib/diagnose/probes/lanIpChanged';
import { checkRouterDnsNotPointing } from '@/lib/diagnose/probes/routerDnsNotPointing';
import { checkPostDeployFailed } from '@/lib/diagnose/probes/postDeployFailed';
import { checkProxyRouteMissing } from '@/lib/diagnose/probes/proxyRouteMissing';
import '@/lib/diagnose/probes/register';

export const dynamic = 'force-dynamic';

type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DiagnoseProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
  hint?: string;
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

/**
 * POST /api/system/diagnose
 * Runs a battery of self-tests against a managed node (default: Local) and
 * returns structured results so the UI can show traffic-light status with
 * actionable hints.
 *
 * Body: `{ node?: string }` — defaults to "Local" if omitted.
 */
export async function POST(request: Request) {
  let nodeName = 'Local';
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.node === 'string' && body.node) nodeName = body.node;
  } catch {
    // ignore — keep default
  }

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
    return NextResponse.json({ node: nodeName, probes });
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
    exec('podman ps --format "{{.Names}}|{{.Status}}" 2>/dev/null', 4000),
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

  // 5) Listening ports for known services
  const ports = trimOutput(listen.stdout, 50).split('\n').filter(Boolean);
  probes.push({
    id: 'ports',
    label: 'Open TCP ports',
    status: ports.length > 0 ? 'info' : 'warn',
    detail: ports.length > 0 ? `Listening on: ${ports.join(', ')}` : 'No ports detected — services may still be starting.',
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
  const treatYoungAsLoop = systemUptimeSec > recentBootGrace;

  const psLines = trimOutput(psStatus.stdout, 80).split('\n').filter(Boolean);
  const looping = psLines.filter(l => {
    const status = (l.split('|')[1] ?? '').trim();
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
    const name = (o.line.split('|')[0] ?? '').trim();
    const podmanStatus = (o.line.split('|')[1] ?? '').trim();
    return {
      id: name,
      label: name,
      detail: o.snippet ? `${podmanStatus} — ${o.snippet.split('\n').slice(-2).join(' | ')}` : podmanStatus,
      status: 'warn',
      actionIds: ['restart_pod', 'show_recent_logs'],
    };
  }).filter(item => item.id);

  probes.push({
    id: 'crash_loop',
    label: 'Containers stable',
    status: psStatus.code !== 0 ? 'warn' : (looping.length === 0 ? 'ok' : 'warn'),
    detail: psStatus.code !== 0
      ? (psStatus.stderr || 'podman ps failed')
      : (psLines.length === 0
          ? 'No running containers yet.'
          : looping.length === 0
            ? (treatYoungAsLoop
                ? `${psLines.length} container(s), all stable.`
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
    const twin = DigitalTwinStore.getInstance().nodes[nodeName];
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
    probes.push({
      id: 'dangling_proxy',
      label: 'Reverse-proxy routes',
      status: !proxyService ? 'info' : (danglingItems.length === 0 ? 'ok' : 'warn'),
      detail: !proxyService
        ? 'No managed reverse proxy yet (or its config is not synced to the twin).'
        : danglingItems.length === 0
          ? `${proxyConfig.length} proxy route(s), all reach a known service.`
          : `${danglingItems.length} dangling route(s) — proxy_pass target not published by any managed service or container.`,
      hint: danglingItems.length > 0
        ? 'Click "Delete route" on a row to remove it from NPM. Most often caused by a removed/renamed service.'
        : undefined,
      _items: danglingItems.length > 0 ? danglingItems : undefined,
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
    const npmStale = await checkNpmDataStale(nodeName);
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
    const lanIp = await checkLanIpChanged(nodeName);
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

  // 14b) Proxy route create-failures (B12). Surfaces config entries
  //     where install-time NPM creation came back unconfirmed; per-item
  //     "Retry create" action pushes the route into NPM again.
  try {
    const prm = await checkProxyRouteMissing();
    probes.push({
      id: 'proxy_route_missing',
      label: 'Proxy hosts created',
      status: prm.status,
      detail: prm.detail,
      hint: prm.hint,
      _items: prm.items,
    });
  } catch (e) {
    probes.push({
      id: 'proxy_route_missing',
      label: 'Proxy hosts created',
      status: 'info',
      detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

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

  return NextResponse.json({ node: nodeName, probes: probes.map(withActions) });
}
