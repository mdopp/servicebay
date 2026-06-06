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

describe('update_service_yaml / get_service_files field-name footgun (#1752)', () => {
  it('the tool descriptions make the reversed field-name mapping unambiguous', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map(t => [t.name, t.description ?? '']));

    // get_service_files: kubeContent = .kube Quadlet, yamlContent = pod spec,
    // and the names are flagged as REVERSED from update_service_yaml.
    expect(byName.get_service_files).toMatch(/kubeContent/);
    expect(byName.get_service_files).toMatch(/yamlContent/);
    expect(byName.get_service_files).toMatch(/Quadlet/);
    expect(byName.get_service_files).toMatch(/Pod[- ]spec/i);
    expect(byName.get_service_files).toMatch(/REVERSED/);

    // update_service_yaml: its content field is the POD SPEC (the read tool's
    // yamlContent), explicitly NOT the .kube Quadlet unit.
    expect(byName.update_service_yaml).toMatch(/[Pp]od[- ][Ss]pec/);
    expect(byName.update_service_yaml).toMatch(/NOT.*Quadlet|Quadlet.*NOT|not the `?\.kube`?/i);
    await client.close();
  });

  it('exposes a clearly-named podSpecContent alias on update_service_yaml', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'update_service_yaml');
    const props = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(props.podSpecContent, 'podSpecContent alias must exist').toBeTruthy();
    expect(props.kubeContent, 'kubeContent kept for backwards-compat').toBeTruthy();
    await client.close();
  });

  it('rejects a verbatim round-trip of the .kube Quadlet unit instead of clobbering the pod spec', async () => {
    const { client } = await connectClient();
    // Simulate the footgun: an LLM reads get_service_files and naively passes
    // the `.kube` Quadlet unit (its kubeContent) back into update_service_yaml.
    const quadletUnit = '[Kube]\nYaml=demo.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target';
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { name: 'demo', kubeContent: quadletUnit },
    });
    expect(res.isError, 'must error rather than write the Quadlet unit to the .yml').toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/Quadlet|Pod[- ]spec/i);
    await client.close();
  });
});
