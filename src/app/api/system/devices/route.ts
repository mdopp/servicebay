import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * List device files from a directory on the target node.
 *
 * When `path` is `/dev/serial/by-id` (the Linux convention for stable
 * USB-serial naming) the endpoint resolves each symlink to its
 * canonical `/dev/tty*` target. Podman's `CharDevice` mount doesn't
 * follow symlinks, so returning the resolved path is what makes the
 * variable usable as a device mount. Side effect: the result is
 * pre-filtered to actual USB-serial devices (null/zero/random/…
 * never appear under /dev/serial/by-id), so the InstallerModal's
 * "auto-pick when there's exactly one device" rule fires reliably
 * for the single-stick Z-Wave / Zigbee case.
 *
 * For any other `path` the endpoint falls back to a flat `ls -1`,
 * preserving the previous behavior for callers that already pass an
 * explicit folder.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  const devicePath = searchParams.get('path') || '/dev/serial/by-id';

  if (!nodeName) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  // Refuse anything that isn't a plain absolute path so an injected
  // `path` can't smuggle shell metacharacters into the exec below.
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(devicePath)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    const agent = await agentManager.ensureAgent(nodeName);
    // For /dev/serial/by-id, resolve each entry's symlink target so
    // callers get a CharDevice-mountable path. Sort + dedupe so a
    // multi-radio stick (one device, multiple by-id symlinks like
    // `…-if00` / `…-if01`) doesn't double up. For other paths, plain
    // ls -1 like before.
    const isByIdPath = devicePath === '/dev/serial/by-id';
    const cmd = isByIdPath
      ? `for f in ${devicePath}/*; do [ -e "$f" ] && readlink -f "$f"; done 2>/dev/null | sort -u`
      : `ls -1 ${devicePath} 2>/dev/null || echo ""`;
    const res = await agent.sendCommand('exec', { command: cmd });

    const devices = (res.stdout || '')
      .split('\n')
      .map((d: string) => d.trim())
      .filter(Boolean)
      .map((name: string) => isByIdPath ? name : `${devicePath}/${name}`);

    return NextResponse.json({ devices });
  } catch (error) {
    return apiError(error, { tag: 'api:system:devices:get', status: 500 });
  }
}
