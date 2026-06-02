import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { listNodes } from '@/lib/nodes';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

async function getAgent() {
  const nodes = await listNodes();
  const nodeName = nodes[0]?.Name || 'Local';
  return agentManager.getAgent(nodeName);
}

// `tokenScope: 'read'` so the sb launcher can poll USB-boot readiness with
// its scoped token (show "would the box boot from USB?" beside ping/webserver)
// without an extra cookie login.
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const agent = await getAgent();
    const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
    if (res.code !== 0) {
      return NextResponse.json({ error: 'Failed to query efibootmgr' }, { status: 500 });
    }
    
    const stdout = res.stdout ?? '';
    const entries: Array<{ bootNum: string; name: string; active: boolean; description: string; current: boolean }> = [];
    
    const lines = stdout.split('\n');
    let bootNext: string | null = null;
    let bootCurrent: string | null = null;
    let bootOrder: string[] = [];
    
    for (const line of lines) {
      if (line.startsWith('BootNext:')) {
        bootNext = line.replace('BootNext:', '').trim();
      } else if (line.startsWith('BootCurrent:')) {
        bootCurrent = line.replace('BootCurrent:', '').trim();
      } else if (line.startsWith('BootOrder:')) {
        bootOrder = line.replace('BootOrder:', '').trim().split(',');
      } else if (line.startsWith('Boot')) {
        const match = line.match(/^Boot([0-9A-Fa-f]+)(\*?)\s+(.+)$/);
        if (match) {
          const bootNum = match[1];
          const active = match[2] === '*';
          const description = match[3];
          entries.push({
            bootNum,
            name: description.split('\t')[0] || description,
            active,
            description,
            current: bootCurrent === bootNum,
          });
        }
      }
    }
    
    const candidates = entries.filter(e => 
      e.description.toLowerCase().includes('usb') || 
      e.description.toLowerCase().includes('removable') ||
      e.description.toLowerCase().includes('disk') ||
      e.description.includes('\\EFI\\boot\\')
    );
    
    return NextResponse.json({
      entries,
      candidates,
      bootNext,
      bootCurrent,
      bootOrder,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('api:system:boot:usb-next', 'GET failed', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

const PostBody = z.object({
  bootNum: z.string().regex(/^[0-9A-Fa-f]{4}$/, 'Must be a 4-digit hex number').optional(),
  reboot: z.boolean().optional().default(false),
});

// `tokenScope: 'mutate'` — sets the firmware's one-shot BootNext (and optionally
// reboots), so the sb "ensure USB boot" action can enable it with a scoped
// token, matching the frontend's enable button.
export const POST = withApiHandler({ body: PostBody, tokenScope: 'mutate' }, async ({ body }) => {
  try {
    const agent = await getAgent();
    
    let bootNum = body.bootNum;
    
    if (!bootNum) {
      const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
      if (res.code === 0) {
        const stdout = res.stdout ?? '';
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.startsWith('Boot') && !line.startsWith('BootOrder') && !line.startsWith('BootNext') && !line.startsWith('BootCurrent')) {
            const match = line.match(/^Boot([0-9A-Fa-f]+)(\*?)\s+(.+)$/);
            if (match) {
              const num = match[1];
              const desc = match[3];
              if (desc.toLowerCase().includes('usb') || desc.toLowerCase().includes('removable') || desc.includes('\\EFI\\boot\\')) {
                bootNum = num;
                break;
              }
            }
          }
        }
      }
    }
    
    if (!bootNum) {
      return NextResponse.json({ error: 'No USB boot entry found or specified' }, { status: 400 });
    }
    
    logger.info('api:system:boot:usb-next', `Activating UEFI boot entry Boot${bootNum}`);
    await agent.sendCommand('exec', { command: `sudo -n efibootmgr -A -b ${bootNum}` });

    logger.info('api:system:boot:usb-next', `Setting UEFI BootNext to ${bootNum}`);
    const resBootNext = await agent.sendCommand('exec', { command: `sudo -n efibootmgr -n ${bootNum}` }) as { code?: number; stderr?: string };
    if (resBootNext.code !== 0) {
      return NextResponse.json({ error: `Failed to set BootNext: ${resBootNext.stderr}` }, { status: 500 });
    }
    
    if (body.reboot) {
      logger.info('api:system:boot:usb-next', 'Rebooting system as requested...');
      // sudo -n: the agent runs as the rootless `core` user, which can't reboot
      // the host without it (a plain `systemctl reboot` is polkit-denied for a
      // non-session service, so it silently no-ops — the box stays armed but
      // never reboots). `core` has passwordless sudo (same as the efibootmgr
      // calls above), so this is the working path. (#usb-next-reboot)
      agent.sendCommand('exec', { command: 'sudo -n systemctl reboot' }).catch(() => {});
    }
    
    return NextResponse.json({
      success: true,
      bootNum,
      message: body.reboot ? 'One-shot BootNext set. System is rebooting.' : 'One-shot BootNext set successfully.',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('api:system:boot:usb-next', 'POST failed', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

export const DELETE = withApiHandler({ tokenScope: 'mutate' }, async () => {
  try {
    const agent = await getAgent();
    logger.info('api:system:boot:usb-next', 'Clearing UEFI BootNext setting');
    const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -N' }) as { code?: number; stderr?: string };
    if (res.code !== 0) {
      return NextResponse.json({ error: `Failed to clear BootNext: ${res.stderr}` }, { status: 500 });
    }
    return NextResponse.json({ success: true, message: 'UEFI BootNext cleared successfully.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('api:system:boot:usb-next', 'DELETE failed', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
