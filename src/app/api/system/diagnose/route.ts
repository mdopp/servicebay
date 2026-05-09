import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { HealthStore } from '@/lib/health/store';
import { DigitalTwinStore } from '@/lib/store/twin';
import { actionsForProbe, type ProbeAction } from '@/lib/diagnose/actions';
import { checkNpmDataStale } from '@/lib/diagnose/probes/npmDataStale';
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
}

/** Attach registry-known actions to a probe. Called once per probe in
 *  the diagnose route. Probes whose status is `ok` skip actions to
 *  avoid noisy "fix it" buttons next to passing checks. */
function withActions(probe: DiagnoseProbe): DiagnoseProbe {
  if (probe.status === 'ok') return probe;
  const actions = actionsForProbe(probe.id);
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

  // 2) Container engine
  const podmanInfo = await exec('podman info --format "{{.Host.Arch}} {{.Host.OS}} {{.Version.Version}}"', 4000);
  probes.push({
    id: 'podman',
    label: 'Podman engine',
    status: podmanInfo.code === 0 ? 'ok' : 'fail',
    detail: podmanInfo.code === 0 ? `podman ${trimOutput(podmanInfo.stdout)}` : (podmanInfo.stderr || 'podman not responding'),
    hint: podmanInfo.code === 0 ? undefined : 'Run `systemctl --user enable --now podman.socket` on the node.',
  });

  // 3) Running pods
  const pods = await exec('podman pod ps --format "{{.Name}}|{{.Status}}|{{.NumberOfContainers}}"', 5000);
  const podLines = trimOutput(pods.stdout, 30).split('\n').filter(Boolean);
  const failedPods = podLines.filter(l => !/Running/i.test(l.split('|')[1] ?? ''));
  probes.push({
    id: 'pods',
    label: 'Pods',
    status: pods.code !== 0 ? 'fail' : (failedPods.length === 0 ? 'ok' : 'warn'),
    detail: pods.code !== 0
      ? (pods.stderr || 'podman pod ps failed')
      : (podLines.length === 0 ? 'No pods deployed yet.' : `${podLines.length} pod(s): ${podLines.length - failedPods.length} running, ${failedPods.length} not running.`),
    hint: failedPods.length > 0 ? `Check pods that aren't running:\n${failedPods.join('\n')}` : undefined,
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
  const failed = await exec('systemctl --user --failed --no-legend --no-pager 2>&1', 5000);
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
  probes.push({
    id: 'failed_units',
    label: 'systemd user units',
    status: realFailed.length === 0 ? 'ok' : 'warn',
    detail,
    hint: realFailed.length > 0 ? `Failed units:\n${realFailed.join('\n')}` : undefined,
  });

  // 5) Listening ports for known services
  const listen = await exec('ss -ltn 2>/dev/null | tail -n +2 | awk \'{print $4}\' | awk -F: \'{print $NF}\' | sort -nu', 4000);
  const ports = trimOutput(listen.stdout, 50).split('\n').filter(Boolean);
  probes.push({
    id: 'ports',
    label: 'Open TCP ports',
    status: ports.length > 0 ? 'info' : 'warn',
    detail: ports.length > 0 ? `Listening on: ${ports.join(', ')}` : 'No ports detected — services may still be starting.',
  });

  // 6) USB serial devices (Z-Wave / Zigbee sticks)
  const serial = await exec('ls -la /dev/serial/by-id/ 2>/dev/null | grep -v "^total" | awk \'{print $NF}\' | grep -v "^$"', 3000);
  const serialDevices = trimOutput(serial.stdout, 20).split('\n').filter(Boolean);
  probes.push({
    id: 'serial',
    label: 'USB serial devices',
    status: serialDevices.length > 0 ? 'ok' : 'info',
    detail: serialDevices.length === 0 ? 'No USB serial devices (no Z-Wave / Zigbee stick plugged in).' : serialDevices.join('\n'),
  });

  // 7) Disk usage on /mnt/data (where ServiceBay stores everything)
  const disk = await exec('df -h /mnt/data 2>/dev/null | tail -1', 3000);
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
      diskHint = 'Storage above 90% — clean old backups or extend the array.';
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
  const firstBoot = await exec(
    'systemctl --no-pager status setup-raid install-python install-nginx 2>&1 | grep -E "(●|Active:)" | head -20',
    5000,
  );
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
  const uptimeRes = await exec('cat /proc/uptime 2>/dev/null', 1500);
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

  const psStatus = await exec('podman ps --format "{{.Names}}|{{.Status}}" 2>/dev/null', 4000);
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
  const offenderDetail = offenderDiagnostics.map(o =>
    o.snippet ? `${o.line}\n      ↳ ${o.snippet.split('\n').join('\n        ')}` : o.line,
  ).join('\n');

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
            : `${looping.length} of ${psLines.length} container(s) may be in a restart loop:\n${offenderDetail}`),
    hint: looping.length > 0
      ? 'The lines under `↳` are the last 3 stderr lines from `podman logs`. Common causes: bind-mount permission mismatch (rootless UID), missing config file, port conflicts, image entrypoint argv errors.'
      : undefined,
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
  try {
    const twin = DigitalTwinStore.getInstance().nodes[nodeName];
    type ProxyServer = {
      _targetPort?: number;
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
    const dangling: string[] = [];
    for (const server of proxyConfig) {
      const targetHost = server.variable_fields?.targetHost;
      const targetPort = server.variable_fields?.targetPort ?? server._targetPort;
      if (!targetPort || !isLocalHost(targetHost)) continue;
      // NPM has internal admin routes (e.g. 127.0.0.1:3000 → its own admin
      // backend, 127.0.0.1:80 → its own UI). Don't flag those.
      const isProxySelfRef = ['127.0.0.1', 'localhost', '::1'].includes(targetHost ?? '');
      if (isProxySelfRef) continue;
      if (!knownPorts.has(targetPort)) {
        const name = (server.server_name ?? []).join(', ') || `(unnamed)`;
        dangling.push(`${name} → ${targetHost}:${targetPort}`);
      }
    }
    probes.push({
      id: 'dangling_proxy',
      label: 'Reverse-proxy routes',
      status: !proxyService ? 'info' : (dangling.length === 0 ? 'ok' : 'warn'),
      detail: !proxyService
        ? 'No managed reverse proxy yet (or its config is not synced to the twin).'
        : dangling.length === 0
          ? `${proxyConfig.length} proxy route(s), all reach a known service.`
          : `${dangling.length} dangling route(s) — proxy_pass target not published by any managed service or container:\n${dangling.join('\n')}`,
      hint: dangling.length > 0
        ? 'Open NPM admin (or Settings → Reverse Proxy) and either fix or delete these routes. Most often caused by a removed/renamed service.'
        : undefined,
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

  return NextResponse.json({ node: nodeName, probes: probes.map(withActions) });
}
