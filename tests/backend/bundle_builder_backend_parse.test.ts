import { describe, expect, test } from 'vitest';
import { buildServiceBundlesForNode } from '@/lib/unmanaged/bundleBuilder';
import type { ServiceUnit, EnrichedContainer, WatchedFile } from '@/lib/agent/types';

const quadletContent = `# /etc/containers/systemd/immich-server.container

[Unit]
Description=Immich Server
Requires=immich-redis.service
Requires=immich-database.service
After=immich-redis.service
After=immich-database.service

[Container]
Pod=immich.pod
ContainerName=immich_server
Image=ghcr.io/immich-app/immich-server:release
Volume=/data/uploads:/data
Volume=/etc/localtime:/etc/localtime:ro
EnvironmentFile=./.env

[Service]
EnvironmentFile=%h/.config/containers/systemd/.env
Healthcheck=none
Restart=always
`;

describe('bundleBuilder backend parsing', () => {
  test('parses relationships from file content even if agent provides none', () => {
    const services: ServiceUnit[] = [
      {
        name: 'immich-server',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Server',
        path: '',
        fragmentPath: '/home/mdopp/.config/containers/systemd/immich-server.container',
        isManaged: false,
        isServiceBay: false,
        isReverseProxy: false,
        associatedContainerIds: [],
        ports: [],
        requires: [],
        after: [],
        wants: [],
        bindsTo: []
      }
    ];

    const containers: EnrichedContainer[] = [];
    const files: Record<string, WatchedFile> = {
      '/home/mdopp/.config/containers/systemd/immich-server.container': {
        path: '/home/mdopp/.config/containers/systemd/immich-server.container',
        content: quadletContent,
        modified: Date.now()
      }
    };

    const bundles = buildServiceBundlesForNode({ nodeName: 'atHome', services, containers, files });
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0];

    // Graph edges should reflect Requires/After parsed from file content
    const reasons = bundle.graph.map(e => `${e.reason}:${e.from}->${e.to}`);
    expect(reasons).toContain('Requires:immich-server->immich-database.service');
    expect(reasons).toContain('Requires:immich-server->immich-redis.service');
    expect(reasons).toContain('After:immich-server->immich-database.service');
    expect(reasons).toContain('After:immich-server->immich-redis.service');
  });
});
