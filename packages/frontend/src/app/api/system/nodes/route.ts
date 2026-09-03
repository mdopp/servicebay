import * as fs from 'fs';
import crypto from 'crypto';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { listNodes, addNode } from '@/lib/nodes';
import { resolveSafeIdentity } from '@/lib/nodes/identityPath';
import { verifyNodeConnection } from '@/lib/nodes/verify';
import { HealthStore } from '@/lib/health/store';
import { logger } from '@/lib/logger';
import { NodeWriteRequestSchema, type NodeMutationResult } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

/**
 * Node CRUD (#2745). This replaced `app/actions/nodes.ts`: the server
 * actions were routed on page paths, so the `/api/*`-only auth gate in
 * `proxy.ts` never covered them and each action had to assert the session
 * itself. As routes they inherit both the proxy gate and `withApiHandler`'s
 * own `requireSession` check.
 */
export const GET = withApiHandler({}, async () => listNodes());

type WriteBody = z.infer<typeof NodeWriteRequestSchema>;

export const POST = withApiHandler<WriteBody>(
  { body: NodeWriteRequestSchema },
  async ({ body }): Promise<NodeMutationResult> => {
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
      await addNode(body.name, body.destination, resolvedIdentity);

      const verification = await verifyNodeConnection(body.name);
      if (!verification.success) {
        return {
          success: true,
          warning: `Node added, but connection check failed: ${verification.error || 'Unknown error'}`,
        };
      }

      registerNodeHealthChecks(body.name);
      return { success: true };
    } catch (error) {
      logger.error('api:system:nodes', 'Failed to create node', error);
      return { success: false, error: 'Failed to create node: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
);

/** A reachable node gets a node probe plus a more frequent agent probe. */
function registerNodeHealthChecks(name: string): void {
  HealthStore.saveCheck({
    id: crypto.randomUUID(),
    name: `Node Health: ${name}`,
    type: 'node',
    target: name,
    interval: 60,
    enabled: true,
    created_at: new Date().toISOString(),
  });
  HealthStore.saveCheck({
    id: crypto.randomUUID(),
    name: `Agent: ${name}`,
    type: 'agent',
    target: name,
    interval: 30,
    enabled: true,
    created_at: new Date().toISOString(),
    nodeName: 'Local',
  });
}
