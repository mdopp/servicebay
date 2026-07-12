/**
 * Headless MCP tool dispatch (#2234).
 *
 * Runs a single MCP tool by name+args over an in-memory transport, with NO
 * auth context — i.e. the cookie/operator path, which bypasses the destroy-tier
 * approval gate and executes the tool inline through the exact same safety flow
 * (snapshot → handler → audit/notify) the `/mcp` endpoint uses. This is how an
 * approved *persistent* approval (lib/approvals) re-runs the destructive tool
 * the agent originally proposed: the operator has already confirmed via the
 * cookie-gated approve route, so re-dispatching without a token auth context is
 * correct — the human IS the operator (see server.ts safeHandler, the
 * `auth == undefined` branch executes inline).
 *
 * The server instance is supplied by the caller (a `createMcpServer` factory)
 * rather than imported here, so this module does NOT depend on `mcp/server` —
 * `server.ts` submits approvals to `lib/approvals`, and a static edge both ways
 * would be a dependency cycle. `server.ts` registers a dispatcher that closes
 * over its own `createMcpServer` at startup.
 *
 * Because the approval record survives a backend restart on disk, the
 * re-dispatch works after a restart too — nothing is captured as an in-memory
 * thunk.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export interface McpToolContent {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content?: McpToolContent[];
  isError?: boolean;
}

/** Minimal shape of the server an in-memory transport can drive. */
export interface DispatchServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connect: (transport: any) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Invoke `toolName` with `args` on a fresh no-auth (operator) MCP server built
 * by `makeServer` and return the tool result. Throws if the tool reports a
 * logical error (`isError: true`) so an approval that failed to execute is
 * surfaced to the operator rather than silently marked approved.
 */
export async function dispatchWithServer(
  makeServer: () => DispatchServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  // No auth → the cookie/operator path in safeHandler: the destroy-tier gate is
  // bypassed and the tool runs inline. The human already approved.
  const server = makeServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'servicebay-approval-dispatch', version: '1.0.0' });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = (await client.callTool({ name: toolName, arguments: args })) as McpToolResult;
    if (result?.isError) {
      const text = result.content?.find(c => typeof c.text === 'string')?.text;
      throw new Error(text || `MCP tool "${toolName}" reported an error`);
    }
    return result;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
