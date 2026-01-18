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

  test('pulls in pod siblings even without explicit dependencies', () => {
    const immichPodContent = `[Unit]
Description=Immich Pod

[Pod]
PublishPort=2283:2283

[Install]
WantedBy=default.target
`;

    const machineLearningContent = `[Unit]
Description=Immich Machine Learning

[Container]
Pod=immich
ContainerName=immich_machine_learning
Image=ghcr.io/immich-app/immich-machine-learning:release
`;

    const services: ServiceUnit[] = [
      {
        name: 'immich',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Pod',
        path: '',
        fragmentPath: '/home/mdopp/.config/containers/systemd/immich.pod',
        isManaged: false,
        isServiceBay: false,
        isReverseProxy: false,
        associatedContainerIds: [],
        ports: [],
        quadletSourceType: 'pod'
      },
      {
        name: 'immich-machine-learning',
        activeState: 'active',
        subState: 'running',
        loadState: 'loaded',
        description: 'Immich Machine Learning',
        path: '',
        fragmentPath: '/home/mdopp/.config/containers/systemd/immich-machine-learning.container',
        isManaged: false,
        isServiceBay: false,
        isReverseProxy: false,
        associatedContainerIds: ['ml'],
        ports: []
      }
    ];

    const containers: EnrichedContainer[] = [
      {
        id: 'ml',
        names: ['/immich_machine_learning'],
        image: 'ghcr.io/immich-app/immich-machine-learning:release',
        state: 'running',
        status: 'running',
        created: Date.now(),
        ports: [],
        mounts: [],
        labels: { 'io.podman.compose.project': 'immich' },
        networks: [],
        podId: 'pod-123',
        podName: 'systemd-immich'
      }
    ];

    const files: Record<string, WatchedFile> = {
      '/home/mdopp/.config/containers/systemd/immich.pod': {
        path: '/home/mdopp/.config/containers/systemd/immich.pod',
        content: immichPodContent,
        modified: Date.now()
      },
      '/home/mdopp/.config/containers/systemd/immich-machine-learning.container': {
        path: '/home/mdopp/.config/containers/systemd/immich-machine-learning.container',
        content: machineLearningContent,
        modified: Date.now()
      }
    };

    const bundles = buildServiceBundlesForNode({ nodeName: 'atHome', services, containers, files });

    expect(bundles).toHaveLength(1);
    const bundle = bundles[0];
    const serviceNames = bundle.services.map(s => s.serviceName).sort();
    expect(serviceNames).toEqual(['immich', 'immich-machine-learning']);
  });

  test('creates synthetic bundles for pods without services', () => {
    const containers: EnrichedContainer[] = [
      {
        id: 'adguard-core',
        names: ['/adguard_core'],
        image: 'docker.io/adguard/adguardhome:latest',
        state: 'running',
        status: 'running',
        created: Date.now(),
        ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
        mounts: [],
        labels: { 'io.podman.pod.name': 'systemd-adguard' },
        networks: [],
        podId: 'pod-adguard',
        podName: 'systemd-adguard'
      },
      {
        id: 'adguard-sidecar',
        names: ['/adguard_sidecar'],
        image: 'docker.io/adguard/helper:latest',
        state: 'running',
        status: 'running',
        created: Date.now(),
        ports: [{ hostPort: 853, containerPort: 853, protocol: 'udp' }],
        mounts: [],
        labels: { 'io.podman.pod.name': 'systemd-adguard' },
        networks: [],
        podId: 'pod-adguard',
        podName: 'systemd-adguard'
      }
    ];

    const files: Record<string, WatchedFile> = {
      '/home/mdopp/.config/containers/systemd/adguard.pod': {
        path: '/home/mdopp/.config/containers/systemd/adguard.pod',
        content: '[Pod]\nPublishPort=8080:80',
        modified: Date.now()
      },
      '/home/mdopp/.config/containers/systemd/adguard.kube': {
        path: '/home/mdopp/.config/containers/systemd/adguard.kube',
        content: 'poggers',
        modified: Date.now()
      }
    };

    const bundles = buildServiceBundlesForNode({ nodeName: 'local', services: [], containers, files });

    expect(bundles).toHaveLength(1);
    const bundle = bundles[0];
    expect(bundle.displayName.toLowerCase()).toContain('adguard');
    expect(bundle.services).toHaveLength(1);
    expect(bundle.services[0].type).toBe('pod');
    expect(bundle.containers).toHaveLength(2);
    expect(bundle.assets.some(asset => asset.path.endsWith('adguard.pod'))).toBe(true);
  });
});
