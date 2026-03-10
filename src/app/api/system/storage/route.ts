import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';

export const dynamic = 'force-dynamic';

interface RaidArray {
  device: string;      // e.g. /dev/md127
  label: string;       // e.g. "data"
  fstype: string;      // e.g. "xfs"
  size: string;        // human-readable
  mountpoint: string | null;
  degraded: boolean;
}

/** Detect RAID arrays and their mount status on a node. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');

  if (!nodeName) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  try {
    const agent = await agentManager.ensureAgent(nodeName);

    // Get block device info as JSON
    const lsblk = await agent.sendCommand('exec', {
      command: `lsblk -J -o NAME,TYPE,FSTYPE,LABEL,SIZE,MOUNTPOINT 2>/dev/null || echo '{"blockdevices":[]}'`
    });

    // Get mdstat for degraded detection
    const mdstat = await agent.sendCommand('exec', {
      command: `cat /proc/mdstat 2>/dev/null || echo ""`
    });

    const blockDevices = JSON.parse(lsblk.stdout || '{"blockdevices":[]}');
    const mdstatText = mdstat.stdout || '';

    const raids: RaidArray[] = [];

    // Find md (RAID) devices in lsblk output
    const findRaids = (devices: Array<Record<string, unknown>>) => {
      for (const dev of devices) {
        if (dev.type === 'raid1' || dev.type === 'raid5' || dev.type === 'raid6' || dev.type === 'raid0' || dev.type === 'raid10' ||
            (typeof dev.name === 'string' && dev.name.startsWith('md'))) {
          const name = dev.name as string;
          const mdDevice = name.startsWith('/') ? name : `/dev/${name}`;

          // Check degraded status from mdstat
          const mdLine = mdstatText.split('\n').find((l: string) => l.includes(name));
          const statusLine = mdLine ? mdstatText.split('\n')[mdstatText.split('\n').indexOf(mdLine) + 1] : '';
          const degraded = statusLine ? /\[U*_+U*\]/.test(statusLine) : false;

          raids.push({
            device: mdDevice,
            label: (dev.label as string) || '',
            fstype: (dev.fstype as string) || '',
            size: (dev.size as string) || '',
            mountpoint: (dev.mountpoint as string) || null,
            degraded,
          });
        }
        // Recurse into children
        if (Array.isArray(dev.children)) {
          findRaids(dev.children as Array<Record<string, unknown>>);
        }
      }
    };

    findRaids(blockDevices.blockdevices || []);

    return NextResponse.json({ raids });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Mount a RAID array and create persistent systemd units. */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');

  if (!nodeName) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  const body = await request.json();
  const { device, mountpoint, label, fstype } = body as {
    device: string;
    mountpoint: string;
    label?: string;
    fstype?: string;
  };

  if (!device || !mountpoint) {
    return NextResponse.json({ error: 'Missing device or mountpoint' }, { status: 400 });
  }

  // Sanitize inputs to prevent command injection
  const safeDevice = device.replace(/[^a-zA-Z0-9/_.-]/g, '');
  const safeMountpoint = mountpoint.replace(/[^a-zA-Z0-9/_.-]/g, '');
  const safeLabel = (label || '').replace(/[^a-zA-Z0-9._-]/g, '');
  const safeFs = (fstype || 'xfs').replace(/[^a-zA-Z0-9]/g, '');

  // Derive systemd unit name from mountpoint (e.g. /var/mnt/data -> var-mnt-data.mount)
  const unitName = safeMountpoint.replace(/^\//, '').replace(/\//g, '-');
  const whatDevice = safeLabel ? `/dev/disk/by-label/${safeLabel}` : safeDevice;

  try {
    const agent = await agentManager.ensureAgent(nodeName);

    // 1. Set RAID to read-write if needed
    await agent.sendCommand('exec', {
      command: `sudo mdadm --readwrite ${safeDevice} 2>/dev/null || true`
    });

    // 2. Create mountpoint and mount
    const mountRes = await agent.sendCommand('exec', {
      command: `sudo mkdir -p ${safeMountpoint} && sudo mount ${safeDevice} ${safeMountpoint}`
    });
    if (mountRes.code !== 0) {
      return NextResponse.json({ error: `Mount failed: ${mountRes.stderr}` }, { status: 500 });
    }

    // 2b. Set SELinux context and ownership so rootless Podman can create volumes
    await agent.sendCommand('exec', {
      command: `sudo chown $(id -u):$(id -g) ${safeMountpoint} && sudo chcon -t container_file_t ${safeMountpoint} 2>/dev/null || true`
    });

    // 3. Create systemd unit to set RAID read-write on boot
    const mdName = safeDevice.split('/').pop();
    await agent.sendCommand('exec', {
      command: `cat <<'UNIT' | sudo tee /etc/systemd/system/mdadm-readwrite.service
[Unit]
Description=Set ${mdName} to read-write mode
Before=${unitName}.mount
After=mdmonitor.service
Requires=mdmonitor.service

[Service]
Type=oneshot
ExecStart=/usr/sbin/mdadm --readwrite ${safeDevice}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT`
    });

    // 4. Create persistent mount unit
    await agent.sendCommand('exec', {
      command: `cat <<'UNIT' | sudo tee /etc/systemd/system/${unitName}.mount
[Unit]
Description=Mount RAID array (${safeLabel || mdName})
After=mdadm-readwrite.service
Requires=mdadm-readwrite.service

[Mount]
What=${whatDevice}
Where=${safeMountpoint}
Type=${safeFs}
Options=defaults,nofail

[Install]
WantedBy=multi-user.target
UNIT`
    });

    // 5. Enable units
    await agent.sendCommand('exec', {
      command: `sudo systemctl daemon-reload && sudo systemctl enable mdadm-readwrite.service ${unitName}.mount`
    });

    return NextResponse.json({
      mounted: true,
      mountpoint: safeMountpoint,
      device: safeDevice,
      persistent: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
