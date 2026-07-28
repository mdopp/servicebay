/**
 * Shared plumbing for the per-tool-group MCP registration modules (#2384).
 *
 * `server.ts` owns the safety layer (one-shot binding → scope gate →
 * mutation/exec guards → approval gate → snapshot/audit/notify) and hands each
 * group module a `ToolServer` whose `.tool()` already wraps every handler in
 * it. A group module therefore only *describes* tools; it never re-implements
 * a guard, and registering a tool from a new module is automatically covered.
 *
 * Deliberately free of any import from `server.ts` so the dependency runs one
 * way (`server.ts` → `tools/*`) with no cycle.
 */
import { z } from 'zod';
import { listNodes } from '@/lib/nodes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolResult = any;

/**
 * The safety-wrapped registrar `createMcpServer` passes to each group module.
 * Same call shape as the SDK's `McpServer.tool()`, except the handler goes
 * through `safeHandler` before it reaches the SDK.
 */
export interface ToolServer {
  tool(
    name: string,
    description: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (...args: any[]) => Promise<ToolResult>,
  ): unknown;
}

/** Everything a tool-group module needs in order to register its tools. */
export interface ToolRegistration {
  server: ToolServer;
  /**
   * The authenticated token caller, when the server was built with one. Only
   * the provenance-stamping tools (propose_learning, request_token) read it;
   * the scope/approval enforcement itself lives in `server.ts`.
   */
  caller?: string;
}

export const nodeParam = z.string().optional().describe('Node name (defaults to first available node)');

export async function resolveNode(node?: string): Promise<string> {
  if (node) return node;
  const nodes = await listNodes();
  return nodes[0]?.Name || 'Local';
}

export function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

export function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
}
