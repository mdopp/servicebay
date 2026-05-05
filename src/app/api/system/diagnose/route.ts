import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';

export const dynamic = 'force-dynamic';

type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DiagnoseProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  detail: string;
  hint?: string;
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
  const failed = await exec('systemctl --user --failed --no-legend --no-pager 2>&1', 5000);
  const failedServices = trimOutput(failed.stdout, 20).split('\n').filter(Boolean);
  probes.push({
    id: 'failed_units',
    label: 'systemd user units',
    status: failedServices.length === 0 ? 'ok' : 'warn',
    detail: failedServices.length === 0 ? 'No failed user units.' : `${failedServices.length} failed unit(s).`,
    hint: failedServices.length > 0 ? `Failed units:\n${failedServices.join('\n')}` : undefined,
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

  return NextResponse.json({ node: nodeName, probes });
}
