import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/lib/logger';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/gateway/detect
 *
 * background gateway discovery. Runs `ip route show` or queries
 * host routing settings on Fedora CoreOS to autodetect the standard
 * gateway interface subnet IP (e.g. 192.168.1.1, 192.168.0.1, etc.).
 * Returns fritz.box as standard backup.
 */
export const GET = withApiHandler({}, async () => {
  try {
    const { stdout } = await execAsync("ip route show | grep default | awk '{print $3}'");
    const ip = stdout.trim();
    if (ip && ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      return NextResponse.json({ success: true, gateway: ip });
    }
    return NextResponse.json({ success: true, gateway: 'fritz.box' });
  } catch (err) {
    logger.warn('api:system:gateway:detect', 'Failed to read default gateway from ip route', err);
    return NextResponse.json({ success: true, gateway: 'fritz.box' });
  }
});
