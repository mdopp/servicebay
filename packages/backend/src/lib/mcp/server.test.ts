import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, TOOL_SCOPES, tokenHasScope } from './server';
import { ALL_SCOPES } from '@/lib/auth/apiScope';

// #1732: the MCP server describes itself — a top-level `instructions` string
// teaching the node → service → container model, and the
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
    expect(instructions).toMatch(/get_logs/);
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
    // get_logs (#2324) is the merged reader — it explains the service vs
    // container source and points at the `<service>-<app>` naming model.
    expect(byName.get_logs).toMatch(/source/);
    expect(byName.get_logs).toMatch(/<service>-<app>/);
    await client.close();
  });
});

// #2324: consolidate 9 near-duplicate tools into 3 parameterised ones,
// hard-replacing the old names. Each merged tool keeps its cluster's scope.
describe('MCP tool consolidation (#2324)', () => {
  const OLD_NAMES = [
    'get_service_logs', 'get_container_logs', 'get_podman_logs',
    'start_service', 'stop_service', 'restart_service',
    'get_template_readme', 'get_template_yaml', 'get_template_variables',
    // Tier-2 merged pair (list_requests):
    'list_access_requests', 'list_token_requests',
  ];

  it('drops all 9 (+2 Tier-2) old tool names from the tool list', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map(t => t.name));
    for (const old of OLD_NAMES) {
      expect(names.has(old), `${old} must be gone (hard replace)`).toBe(false);
    }
    await client.close();
  });

  it('registers the 3 merged Tier-1 tools + Tier-2 list_requests', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map(t => t.name));
    for (const merged of ['get_logs', 'manage_service', 'get_template_artifact', 'list_requests']) {
      expect(names.has(merged), `${merged} must be registered`).toBe(true);
    }
    await client.close();
  });

  it('exposes the discriminator param on each merged tool', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const prop = (name: string, key: string) => {
      const t = tools.find(x => x.name === name);
      return (t?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    };
    expect(prop('get_logs', 'source').source).toBeTruthy();
    expect(prop('manage_service', 'action').action).toBeTruthy();
    expect(prop('get_template_artifact', 'artifact').artifact).toBeTruthy();
    expect(prop('list_requests', 'type').type).toBeTruthy();
    await client.close();
  });

  it('keeps each merged tool in its cluster scope', () => {
    // get_logs / get_template_artifact / list_requests stay read; the old
    // members were all read. manage_service stays lifecycle.
    expect(TOOL_SCOPES.get_logs).toBe('read');
    expect(TOOL_SCOPES.get_template_artifact).toBe('read');
    expect(TOOL_SCOPES.list_requests).toBe('read');
    expect(TOOL_SCOPES.manage_service).toBe('lifecycle');
    // The old names carry no scope entry anymore.
    for (const old of OLD_NAMES) {
      expect(TOOL_SCOPES[old], `${old} scope entry removed`).toBeUndefined();
    }
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

// #1765: reboot_node is split out of the `destroy` tier into its own
// `reboot` tier — a reboot is transient/recoverable and must NOT require
// granting irreversible delete/wipe via `destroy`. `destroy` keeps
// implying `reboot` for legacy-token back-compat.
describe('reboot scope split (#1765)', () => {
  it('classifies reboot_node as the reboot tier, not destroy', () => {
    expect(TOOL_SCOPES.reboot_node).toBe('reboot');
  });

  it('keeps the irreversible tools in destroy', () => {
    expect(TOOL_SCOPES.delete_service).toBe('destroy');
    expect(TOOL_SCOPES.factory_reset).toBe('destroy');
    expect(TOOL_SCOPES.purge_trashed_service).toBe('destroy');
    // set_boot_next_usb stays destroy — it can arm a USB-installer reboot.
    expect(TOOL_SCOPES.set_boot_next_usb).toBe('destroy');
  });

  it('exposes reboot as a mintable scope', () => {
    expect(ALL_SCOPES).toContain('reboot');
  });

  it('lets an operate token reboot but refuses delete/factory_reset', () => {
    const operate = ['read', 'lifecycle', 'mutate', 'reboot'] as const;
    expect(tokenHasScope(operate, TOOL_SCOPES.manage_service)).toBe(true);
    expect(tokenHasScope(operate, TOOL_SCOPES.reboot_node)).toBe(true);
    expect(tokenHasScope(operate, TOOL_SCOPES.delete_service)).toBe(false);
    expect(tokenHasScope(operate, TOOL_SCOPES.factory_reset)).toBe(false);
  });

  it('lets a legacy destroy token still reboot (back-compat)', () => {
    expect(tokenHasScope(['read', 'destroy'], 'reboot')).toBe(true);
  });

  it('does not let a reboot grant imply destroy', () => {
    expect(tokenHasScope(['reboot'], 'destroy')).toBe(false);
  });
});
