import * as fs from 'fs';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import { updateNode, removeNode, type PodmanConnection } from '@/lib/nodes';
import { resolveSafeIdentity } from '@/lib/nodes/identityPath';
import { verifyNodeConnection } from '@/lib/nodes/verify';
import { HealthStore } from '@/lib/health/store';
import { logger } from '@/lib/logger';
import { NodeWriteRequestSchema, type NodeMutationResult } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

type WriteBody = z.infer<typeof NodeWriteRequestSchema>;
type Params = { name: string };

/** PATCH /api/system/nodes/:name — rename / repoint an existing node (#2745). */
export const PATCH = withApiHandlerParams<WriteBody, undefined, Params>(
  { body: NodeWriteRequestSchema },
  async ({ body, params }): Promise<NodeMutationResult> => {
    // Constrain the identity path to an allowed SSH-key dir before it reaches
    // the filesystem or the stored node (path-injection barrier).
    const resolvedIdentity = resolveSafeIdentity(body.identity);
    if (!resolvedIdentity) {
      return { success: false, error: 'Identity path must be an SSH key under the managed key directory or ~/.ssh.' };
    }
    if (!fs.existsSync(resolvedIdentity)) {
      return { success: false, error: `Identity file not found at ${resolvedIdentity}` };
    }

    try {
      const patch: Partial<PodmanConnection> = {
        Name: body.name,
        URI: body.destination,
        Identity: resolvedIdentity,
      };
      await updateNode(params.name, patch);

      const verification = await verifyNodeConnection(body.name);
      if (!verification.success) {
        return {
          success: true,
          warning: `Node updated, but connection check failed: ${verification.error || 'Unknown error'}`,
        };
      }
      return { success: true };
    } catch (error) {
      logger.error('api:system:nodes', 'Failed to update node', error);
      return { success: false, error: 'Failed to update node: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
);

/** DELETE /api/system/nodes/:name — drop the node and its health checks. */
export const DELETE = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }): Promise<NodeMutationResult> => {
    try {
      await removeNode(params.name);

      const orphaned = HealthStore.getChecks().filter(
        check =>
          check.nodeName === params.name ||
          check.name === `Node Health: ${params.name}` ||
          check.name === `Agent: ${params.name}`,
      );
      orphaned.forEach(check => HealthStore.deleteCheck(check.id));

      return { success: true };
    } catch (error) {
      logger.error('api:system:nodes', 'Failed to delete node', error);
      return { success: false, error: 'Failed to delete node' };
    }
  },
);
