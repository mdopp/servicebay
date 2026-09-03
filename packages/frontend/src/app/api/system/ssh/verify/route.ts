import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { checkTcpConnection, verifySSHConnection } from '@/lib/ssh';
import { SshVerifyRequestSchema } from '@servicebay/api-client';
import type { SshVerifyResultSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

type Body = z.infer<typeof SshVerifyRequestSchema>;

/**
 * POST /api/system/ssh/verify — TCP then public-key auth (#2745, was
 * `app/actions/ssh.ts:checkFullConnection`). `stage` tells the settings UI
 * whether the box is unreachable (`tcp`) or reachable but rejecting the key
 * (`auth`) — the latter is what opens the "install the SSH key" modal.
 */
export const POST = withApiHandler<Body>(
  { body: SshVerifyRequestSchema },
  async ({ body }): Promise<z.infer<typeof SshVerifyResultSchema>> => {
    try {
      const isOpen = await checkTcpConnection(body.host, body.port);
      if (!isOpen) return { success: false, stage: 'tcp', error: 'TCP Connection Failed' };

      const authenticated = await verifySSHConnection(body.host, body.port, body.user, body.identity);
      if (!authenticated) return { success: false, stage: 'auth', error: 'SSH Authentication Failed' };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
);
