import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server';

// #1732: the MCP server describes itself — a top-level `instructions` string
// teaching the node → service → container model, and the four
// service/container/log tools mention that model in their descriptions.
// Verified end-to-end through the SDK initialize + tools/list handshake.
async function connectClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

describe('createMcpServer self-description (#1732)', () => {
  it('returns an instructions string covering the service↔container model on initialize', async () => {
    const { client } = await connectClient();
    const instructions = client.getInstructions();
    expect(instructions, 'initialize handshake must return instructions').toBeTruthy();
    expect(instructions).toMatch(/node\s*→\s*service\s*→\s*container/);
    // Tells the agent how to find an app's logs and to resolve names itself.
    expect(instructions).toMatch(/list_services/);
    expect(instructions).toMatch(/get_container_logs/);
    expect(instructions).toMatch(/resolve.*names?.*yourself|rather than asking the user/i);
    await client.close();
  });

  it('the service/container/log tool descriptions mention the naming model', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map(t => [t.name, t.description ?? '']));

    expect(byName.list_services).toMatch(/container/i);
    expect(byName.list_services).toMatch(/associatedContainerIds/);
    expect(byName.list_containers).toMatch(/<service>-<app>/);
    expect(byName.get_service_logs).toMatch(/get_container_logs/);
    expect(byName.get_container_logs).toMatch(/<service>-<app>/);
    await client.close();
  });
});
