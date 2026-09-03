import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { checkTcpConnection } from '@/lib/ssh';
import { SshCheckRequestSchema } from '@servicebay/api-client';
import type { SshCheckResultSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

type Body = z.infer<typeof SshCheckRequestSchema>;

/**
 * POST /api/system/ssh/check — TCP reachability probe (#2745, was
 * `app/actions/ssh.ts:checkConnection`). "Port shut" is an answer the UI
 * renders, so it comes back as `success: true, isOpen: false` on HTTP 200;
 * only a thrown probe error becomes `success: false`.
 */
export const POST = withApiHandler<Body>(
  { body: SshCheckRequestSchema },
  async ({ body }): Promise<z.infer<typeof SshCheckResultSchema>> => {
    try {
      const isOpen = await checkTcpConnection(body.host, body.port);
      return { success: true, isOpen };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
);
