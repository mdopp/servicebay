import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

interface RaidArray {
  device: string;      // e.g. /dev/md127
  label: string;       // e.g. "data"
  fstype: string;      // e.g. "xfs"
  size: string;        // human-readable
  mountpoint: string | null;
  degraded: boolean;
}

interface DetectedDrive {
  name: string;        // e.g. "sda"
  path: string;        // e.g. "/dev/sda"
  type: string;        // disk / part / raid1 / lvm / ...
  size: string;        // human-readable, e.g. "3.6T"
  model?: string;      // e.g. "WDC WD40EFRX-68N32N0"
  vendor?: string;     // e.g. "ATA"
  serial?: string;     // disk serial; useful for distinguishing two same-model drives
  rota?: boolean;      // true = HDD, false = SSD/NVMe
  fstype?: string;     // e.g. "xfs", "linux_raid_member"
  label?: string;
  mountpoint?: string | null;
  fsAvail?: string;    // human-readable free space when mounted
  fsUsedPct?: string;  // e.g. "23%"
  children?: DetectedDrive[];
}

interface RawLsblkNode {
  name?: string;
  path?: string;
  type?: string;
  size?: string;
  model?: string;
  vendor?: string;
  serial?: string;
  rota?: boolean;
  fstype?: string;
  label?: string;
  mountpoint?: string | null;
  fsavail?: string;
  'fsuse%'?: string;
  children?: RawLsblkNode[];
}

const trim = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
};

const mapNode = (raw: RawLsblkNode): DetectedDrive => {
  const name = (raw.name ?? '').toString();
  const path = raw.path ?? (name.startsWith('/') ? name : `/dev/${name}`);
  const node: DetectedDrive = {
    name,
    path,
    type: (raw.type ?? '').toString(),
    size: (raw.size ?? '').toString(),
    model: trim(raw.model),
    vendor: trim(raw.vendor),
    serial: trim(raw.serial),
    rota: typeof raw.rota === 'boolean' ? raw.rota : undefined,
    fstype: trim(raw.fstype),
    label: trim(raw.label),
    mountpoint: raw.mountpoint ?? null,
    fsAvail: trim(raw.fsavail),
    fsUsedPct: trim(raw['fsuse%']),
  };
  if (Array.isArray(raw.children) && raw.children.length > 0) {
    node.children = raw.children.map(mapNode);
  }
  return node;
};

/** Detect RAID arrays and physical drives on a node.
 *
 * Returns:
 *   - `raids`: backwards-compatible RAID-only summary the wizard already
 *     uses for the "mount your data drive" prompt.
 *   - `drives`: every top-level block device with model/serial/size/free
 *     space, so the wizard can show "what hardware did we see" before the
 *     operator commits to an install. This was added because two recent
 *     installs on the same hardware behaved differently and there was no
 *     way to tell from the install log whether all expected disks were
 *     even visible.
 */
const GetQuery = z.object({ node: z.string().min(1) });

export const GET = withApiHandler<undefined, z.infer<typeof GetQuery>>(
  { query: GetQuery },
  async ({ query, request }) => {
  const nodeName = query.node;

  try {
    const agent = await agentManager.ensureAgent(nodeName);

    // Pull a fuller column set than before. NB: not every util-linux
    // version supports every column. The `2>/dev/null` + JSON fallback
    // keeps older agents from crashing the call; if a column is missing
    // it just shows up as undefined for that drive.
    const lsblk = await agent.sendCommand('exec', {
      command: `lsblk -J -b -o NAME,PATH,TYPE,SIZE,MODEL,VENDOR,SERIAL,ROTA,FSTYPE,LABEL,MOUNTPOINT,FSAVAIL,FSUSE% 2>/dev/null || lsblk -J -o NAME,TYPE,FSTYPE,LABEL,SIZE,MOUNTPOINT 2>/dev/null || echo '{"blockdevices":[]}'`
    });

    // Get mdstat for degraded detection
    const mdstat = await agent.sendCommand('exec', {
      command: `cat /proc/mdstat 2>/dev/null || echo ""`
    });

    const blockDevices = JSON.parse(lsblk.stdout || '{"blockdevices":[]}');
    const mdstatText = mdstat.stdout || '';

    // Re-render byte sizes as human-readable so the UI doesn't have to
    // carry a formatter. lsblk -b returns bytes; without -b lsblk
    // already returns human-readable. Detect by sniffing the first leaf.
    const looksLikeBytes = (() => {
      const probe = (nodes: RawLsblkNode[]): boolean => {
        for (const n of nodes) {
          if (typeof n.size === 'string' && /^\d+$/.test(n.size)) return true;
          if (n.children && probe(n.children)) return true;
        }
        return false;
      };
      return probe(blockDevices.blockdevices ?? []);
    })();
    const fmtBytes = (b: number): string => {
      const units = ['B', 'K', 'M', 'G', 'T', 'P'];
      let v = b;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
    };
    const humanizeSizes = (node: DetectedDrive) => {
      if (looksLikeBytes && node.size && /^\d+$/.test(node.size)) {
        node.size = fmtBytes(parseInt(node.size, 10));
      }
      if (looksLikeBytes && node.fsAvail && /^\d+$/.test(node.fsAvail)) {
        node.fsAvail = fmtBytes(parseInt(node.fsAvail, 10));
      }
      node.children?.forEach(humanizeSizes);
    };

    const drives: DetectedDrive[] = (blockDevices.blockdevices ?? []).map(mapNode);
    drives.forEach(humanizeSizes);

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

          // Re-derive the human-readable size from the matching drive.
          // After humanizeSizes runs `drives` already has friendly sizes;
          // the original `dev.size` here is still raw bytes if -b worked.
          const sizeStr = (() => {
            const findSize = (nodes: DetectedDrive[]): string | undefined => {
              for (const n of nodes) {
                if (n.path === mdDevice) return n.size;
                const inner = n.children ? findSize(n.children) : undefined;
                if (inner) return inner;
              }
              return undefined;
            };
            return findSize(drives) ?? (dev.size as string) ?? '';
          })();

          raids.push({
            device: mdDevice,
            label: (dev.label as string) || '',
            fstype: (dev.fstype as string) || '',
            size: sizeStr,
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

    return NextResponse.json({ raids, drives });
  } catch (error) {
    return apiError(error, { tag: 'api:system:storage:get', status: 500 });
  }
  },
);

const PostBody = z.object({
  device: z.string().min(1),
  mountpoint: z.string().min(1),
  label: z.string().optional(),
  fstype: z.string().optional(),
});
const PostQuery = z.object({ node: z.string().min(1) });

/** Mount a RAID array and create persistent systemd units. */
export const POST = withApiHandler<z.infer<typeof PostBody>, z.infer<typeof PostQuery>>(
  { body: PostBody, query: PostQuery },
  async ({ body, query }) => {
  const nodeName = query.node;
  const { device, mountpoint, label, fstype } = body;

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
    return apiError(error, { tag: 'api:system:storage:post', status: 500 });
  }
  },
);
