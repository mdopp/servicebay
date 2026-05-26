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

export const GET = withApiHandler({}, async () => {
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

export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
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
      agent.sendCommand('exec', { command: 'systemctl reboot' }).catch(() => {});
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

export const DELETE = withApiHandler({}, async () => {
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
