import { describe, expect, test } from 'vitest';
import { buildServiceBundlesForNode } from '@/lib/unmanaged/bundleBuilder';
import type { ServiceUnit, EnrichedContainer, WatchedFile } from '@/lib/agent/types';

describe('bundleBuilder pod grouping', () => {
  test('groups services by pod reference into one bundle', () => {
    const immichServerContent = `[Unit]
Description=Immich Server
Requires=immich-redis.service
Requires=immich-database.service

[Container]
Pod=immich
ContainerName=immich_server
Image=ghcr.io/immich-app/immich-server:release
`;

    const immichRedisContent = `[Unit]
Description=Immich Redis

[Container]
Pod=immich
ContainerName=immich_redis
Image=docker.io/valkey/valkey
`;

    const immichDatabaseContent = `[Unit]
Description=Immich Database

[Container]
Pod=immich
ContainerName=immich_database
Image=postgres:latest
`;

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
        ports: []
      },
      {
        name: 'immich-redis',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Redis',
        path: '',
        fragmentPath: '/home/mdopp/.config/containers/systemd/immich-redis.container',
        isManaged: false,
        isServiceBay: false,
        isReverseProxy: false,
        associatedContainerIds: [],
        ports: []
      },
      {
        name: 'immich-database',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Database',
        path: '',
        fragmentPath: '/home/mdopp/.config/containers/systemd/immich-database.container',
        isManaged: false,
        isServiceBay: false,
        isReverseProxy: false,
        associatedContainerIds: [],
        ports: []
      }
    ];

    const containers: EnrichedContainer[] = [];
    const files: Record<string, WatchedFile> = {
      '/home/mdopp/.config/containers/systemd/immich-server.container': {
        path: '/home/mdopp/.config/containers/systemd/immich-server.container',
        content: immichServerContent,
        modified: Date.now()
      },
      '/home/mdopp/.config/containers/systemd/immich-redis.container': {
        path: '/home/mdopp/.config/containers/systemd/immich-redis.container',
        content: immichRedisContent,
        modified: Date.now()
      },
      '/home/mdopp/.config/containers/systemd/immich-database.container': {
        path: '/home/mdopp/.config/containers/systemd/immich-database.container',
        content: immichDatabaseContent,
        modified: Date.now()
      }
    };

    const bundles = buildServiceBundlesForNode({ nodeName: 'atHome', services, containers, files });
    
    // Should create one bundle for the immich pod
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0];
    
    // Bundle should include all three services
    expect(bundle.services).toHaveLength(3);
    expect(bundle.services.map(s => s.serviceName).sort()).toEqual(['immich-database', 'immich-redis', 'immich-server']);
    
    // Bundle display name should reflect the pod name
    expect(bundle.displayName).toContain('immich');
  });
});
