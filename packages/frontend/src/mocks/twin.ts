/**
 * Fixture digital-twin snapshot for Storybook (Phase 4 of #753) and
 * mock-mode dashboards. Built to satisfy the shape `useDigitalTwin`
 * returns at runtime — minimal but *valid*, with enough services and
 * containers for the dashboards to render a populated view.
 *
 * Add a service: append to `services` AND to `containers` (matching
 * `associatedContainerIds` ↔ container `id`). The two are kept in
 * sync by convention — there's no automatic linker.
 */

import type {
  DigitalTwinSnapshot,
} from '@/providers/DigitalTwinProvider';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTwin = any;

const NOW = Date.parse('2026-05-21T10:00:00Z');

const containers: AnyTwin[] = [
  {
    id: 'cnt-immich',
    names: ['immich-immich'],
    state: 'running',
    image: 'ghcr.io/immich-app/immich-server:release',
    ports: [{ host: 2283, container: 2283, protocol: 'tcp' }],
    networks: { 'podman-default-kube-network': { ip: '10.89.0.5' } },
    labels: {},
  },
  {
    id: 'cnt-postgres',
    names: ['immich-postgres'],
    state: 'running',
    image: 'ghcr.io/immich-app/postgres:14',
    ports: [],
    networks: { 'podman-default-kube-network': { ip: '10.89.0.6' } },
    labels: {},
  },
  {
    id: 'cnt-ha',
    names: ['home-assistant-homeassistant'],
    state: 'running',
    image: 'ghcr.io/home-assistant/home-assistant:stable',
    ports: [{ host: 8123, container: 8123, protocol: 'tcp' }],
    networks: { 'podman-default-kube-network': { ip: '10.89.0.7' } },
    labels: {},
  },
  {
    id: 'cnt-auth-authelia',
    names: ['auth-authelia'],
    state: 'running',
    image: 'docker.io/authelia/authelia:latest',
    ports: [{ host: 9091, container: 9091, protocol: 'tcp' }],
    networks: { 'podman-default-kube-network': { ip: '10.89.0.8' } },
    labels: {},
  },
];

const services: AnyTwin[] = [
  {
    name: 'immich',
    active: true,
    status: 'running',
    associatedContainerIds: ['cnt-immich', 'cnt-postgres'],
    ports: [{ host: 2283, container: 2283 }],
    yamlPath: '/var/mnt/data/stacks/immich/immich.yaml',
    labels: {},
    health: { ready: true, lastChecked: NOW },
  },
  {
    name: 'home-assistant',
    active: true,
    status: 'running',
    associatedContainerIds: ['cnt-ha'],
    ports: [{ host: 8123, container: 8123 }],
    yamlPath: '/var/mnt/data/stacks/home-assistant/home-assistant.yaml',
    labels: {},
    health: { ready: true, lastChecked: NOW },
  },
  {
    name: 'auth',
    active: true,
    status: 'running',
    associatedContainerIds: ['cnt-auth-authelia'],
    ports: [{ host: 9091, container: 9091 }],
    yamlPath: '/var/mnt/data/stacks/auth/auth.yaml',
    labels: { 'servicebay.tier': 'core' },
    health: { ready: true, lastChecked: NOW },
  },
];

export const mockTwinSnapshot: DigitalTwinSnapshot = {
  instanceId: 'mock-instance',
  serverName: 'mock.servicebay',
  nodes: {
    Local: {
      connected: true,
      lastSync: NOW,
      initialSyncComplete: true,
      resources: null,
      containers,
      services,
      volumes: [],
      files: {},
      proxyRoutes: [
        {
          host: 'photos.example.com',
          targetService: 'immich-immich',
          targetPort: 2283,
          ssl: true,
        },
        {
          host: 'ha.example.com',
          targetService: 'home-assistant-homeassistant',
          targetPort: 8123,
          ssl: true,
        },
      ],
      nodeIPs: ['192.168.178.100'],
      unmanagedBundles: [],
      dismissedBundles: [],
      history: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  },
  gateway: {
    provider: 'fritzbox',
    publicIp: '203.0.113.10',
    internalIp: '192.168.178.1',
    upstreamStatus: 'up',
    dnsServers: ['192.168.178.100', '8.8.8.8'],
    lastUpdated: NOW,
  },
  proxyState: {
    provider: 'nginx',
    routes: [],
  },
};

/** Empty-state twin — useful for first-boot / "nothing installed yet"
 *  story variants. */
export const emptyTwinSnapshot: DigitalTwinSnapshot = {
  instanceId: 'mock-instance-empty',
  serverName: 'mock.servicebay',
  nodes: {
    Local: {
      connected: true,
      lastSync: NOW,
      initialSyncComplete: true,
      resources: null,
      containers: [],
      services: [],
      volumes: [],
      files: {},
      proxyRoutes: [],
      nodeIPs: ['192.168.178.100'],
      unmanagedBundles: [],
      dismissedBundles: [],
      history: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  },
  gateway: {
    provider: 'fritzbox',
    publicIp: '0.0.0.0',
    upstreamStatus: 'down',
    lastUpdated: NOW,
  },
  proxyState: {
    provider: 'nginx',
    routes: [],
  },
};
