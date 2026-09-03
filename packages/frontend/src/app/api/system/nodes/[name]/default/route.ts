import { withApiHandlerParams } from '@/lib/api/handler';
import { setDefaultNode } from '@/lib/nodes';
import { logger } from '@/lib/logger';
import type { NodeMutationResult } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

/** POST /api/system/nodes/:name/default — promote a node to the default (#2745). */
export const POST = withApiHandlerParams<undefined, undefined, { name: string }>(
  {},
  async ({ params }): Promise<NodeMutationResult> => {
    try {
      await setDefaultNode(params.name);
      return { success: true };
    } catch (error) {
      logger.error('api:system:nodes', 'Failed to set default node', error);
      return { success: false, error: 'Failed to set default node' };
    }
  },
);
