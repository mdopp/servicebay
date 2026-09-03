import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { setupSSHKey } from '@/lib/ssh';
import { SshInstallKeyRequestSchema } from '@servicebay/api-client';
import type { SshInstallKeyResultSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

type Body = z.infer<typeof SshInstallKeyRequestSchema>;

/**
 * POST /api/system/ssh/install-key — ssh-copy-id the managed key onto a remote
 * host (#2745, was `app/actions/ssh.ts:installSSHKey`). `logs` is the transcript
 * the SSH setup modal streams back to the operator; a thrown error is folded
 * into the same `logs` array so the modal always has something to show.
 */
export const POST = withApiHandler<Body>(
  { body: SshInstallKeyRequestSchema },
  async ({ body }): Promise<z.infer<typeof SshInstallKeyResultSchema>> => {
    try {
      return await setupSSHKey(body.host, body.port, body.user, body.pass);
    } catch (e) {
      return { success: false, logs: [String(e)] };
    }
  },
);
