import { getExecutor } from '@/lib/executor';
import { listNodes } from '@/lib/nodes';

/** The requested node name is not in the node store — a 404, not a read failure. */
export class NodeNotFoundError extends Error {
  constructor(nodeName: string) {
    super(`Node ${nodeName} not found`);
    this.name = 'NodeNotFoundError';
  }
}

/**
 * Read a file through the executor for `nodeName` (`undefined`/`Local` = the
 * box itself). Shared by `GET /api/system/files` and the server-rendered file
 * viewer page so both resolve the node the same way — the viewer used to reach
 * this through the `app/actions/system.ts` server action (#2745).
 */
export async function readFileOnNode(filePath: string, nodeName?: string): Promise<string> {
  let connection;
  if (nodeName && nodeName !== 'Local') {
    const nodes = await listNodes();
    connection = nodes.find(node => node.Name === nodeName);
    if (!connection) throw new NodeNotFoundError(nodeName);
  }
  return getExecutor(connection).readFile(filePath);
}
