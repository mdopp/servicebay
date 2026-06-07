import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// #1778: update_service_yaml must route a single-container `.container`
// Quadlet (ollama after the GPU fixup) to deployContainerQuadlet — writing the
// edited unit body straight back — instead of treating it as a `.kube` pod
// spec and rejecting it via the footgun guard. We mock ServiceManager so the
// SDK round-trip asserts the wiring without a real agent/box.
const getServiceFiles = vi.fn();
const deployContainerQuadlet = vi.fn(async (..._args: unknown[]) => undefined);
const deployKubeService = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    getServiceFiles: (...args: unknown[]) => getServiceFiles(...args),
    deployContainerQuadlet: (...args: unknown[]) => deployContainerQuadlet(...args),
    deployKubeService: (...args: unknown[]) => deployKubeService(...args),
  },
}));

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

const OLLAMA_BODY = [
  '[Unit]',
  'Description=Ollama',
  '',
  '[Container]',
  'Image=docker.io/ollama/ollama:latest',
  'AddDevice=nvidia.com/gpu=all',
  'PublishPort=11434:11434',
].join('\n');

describe('update_service_yaml — .container Quadlet routing (#1778)', () => {
  beforeEach(() => {
    getServiceFiles.mockReset();
    deployContainerQuadlet.mockReset();
    deployKubeService.mockReset();
  });

  it('writes the edited .container unit body back via deployContainerQuadlet', async () => {
    getServiceFiles.mockResolvedValue({
      kubeContent: OLLAMA_BODY,
      yamlContent: '',
      yamlPath: '',
      quadletKind: 'container',
      kubePath: '/var/home/core/.config/containers/systemd/ollama.container',
    });
    const { client } = await connectClient();
    const edited = OLLAMA_BODY.replace('11434:11434', '11434:11434\nEnvironment=OLLAMA_DEBUG=1');
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { node: 'local', name: 'ollama', kubeContent: edited },
    });
    expect(res.isError).toBeFalsy();
    expect(deployContainerQuadlet).toHaveBeenCalledTimes(1);
    expect(deployKubeService).not.toHaveBeenCalled();
    // Targets the real service name with the edited unit body.
    expect(deployContainerQuadlet).toHaveBeenCalledWith('local', 'ollama', edited);
    await client.close();
  });

  it('does not look up the service for the common .kube pod-spec path (no [Container])', async () => {
    // A pod spec carries no `[Container]` section, so the .container lookup is
    // skipped entirely — keeps the hot path off a per-call agent round-trip.
    getServiceFiles.mockResolvedValue({ quadletKind: 'kube' });
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { node: 'local', name: 'vaultwarden', podSpecContent: 'apiVersion: v1\nkind: Pod\nspec:\n  containers: []\n' },
    });
    expect(res.isError).toBeFalsy();
    expect(getServiceFiles).not.toHaveBeenCalled();
    expect(deployKubeService).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('falls through to the footgun guard when a [Container] body is passed for a .kube service', async () => {
    getServiceFiles.mockResolvedValue({ quadletKind: 'kube', kubeContent: '[Kube]\nYaml=x.yml' });
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { node: 'local', name: 'vaultwarden', kubeContent: '[Container]\nImage=x' },
    });
    expect(res.isError).toBe(true);
    expect(deployContainerQuadlet).not.toHaveBeenCalled();
    expect(deployKubeService).not.toHaveBeenCalled();
    await client.close();
  });

  it('still routes a .kube service through deployKubeService (pod spec)', async () => {
    getServiceFiles.mockResolvedValue({
      kubeContent: '[Kube]\nYaml=vaultwarden.yml',
      yamlContent: 'apiVersion: v1\nkind: Pod\n',
      yamlPath: '/x/vaultwarden.yml',
      quadletKind: 'kube',
      kubePath: '/x/vaultwarden.kube',
    });
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'update_service_yaml',
      arguments: { node: 'local', name: 'vaultwarden', podSpecContent: 'apiVersion: v1\nkind: Pod\nspec:\n  containers: []\n' },
    });
    expect(res.isError).toBeFalsy();
    expect(deployKubeService).toHaveBeenCalledTimes(1);
    expect(deployContainerQuadlet).not.toHaveBeenCalled();
    await client.close();
  });
});
