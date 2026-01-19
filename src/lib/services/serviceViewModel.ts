import type { ServiceUnit, EnrichedContainer, ProxyRoute } from '@/lib/agent/types';
import type { NodeTwin } from '@/lib/store/twin';
import type { ServiceViewModel, ServicePort } from '@/types/serviceView';

interface BuildServiceViewModelArgs {
  unit: ServiceUnit;
  nodeName: string;
  nodeState: NodeTwin;
  proxyRoutes?: ProxyRoute[];
}

const formatPort = (port?: { hostPort?: number; containerPort?: number }): ServicePort => ({
  host: port?.hostPort !== undefined ? String(port.hostPort) : '',
  container: port?.containerPort !== undefined ? String(port.containerPort) : '',
});

const cloneContainerWithNode = (container: EnrichedContainer, nodeName: string): EnrichedContainer => ({
  ...container,
  nodeName,
});

export function buildServiceViewModel({ unit, nodeName, nodeState, proxyRoutes }: BuildServiceViewModelArgs): ServiceViewModel | null {
  const isManaged = Boolean(unit.isManaged);

  if (!isManaged && !unit.isReverseProxy && !unit.isServiceBay) {
    return null;
  }

  const fileKeys = Object.keys(nodeState.files || {});
  const baseName = unit.name.replace('.service', '');
  let yamlPath: string | null = null;

  if (isManaged) {
    const filePath = fileKeys.find(key => key.endsWith(`/${baseName}.kube`));
    if (filePath) {
      yamlPath = filePath;
      const file = nodeState.files?.[filePath];
      if (file?.content) {
        const match = file.content.match(/^Yaml=(.+)$/m);
        if (match) {
          const yamlFile = match[1].trim();
          const yamlKey = fileKeys.find(key => key.endsWith(`/${yamlFile}`));
          if (yamlKey) {
            yamlPath = yamlKey;
          }
        }
      }
    }
  } else {
    const fallbackYaml = fileKeys.find(key => key.endsWith(`/${baseName}.yml`) || key.endsWith(`/${baseName}.yaml`));
    if (fallbackYaml) {
      yamlPath = fallbackYaml;
    }
  }

  const containerLookup = new Map<string, EnrichedContainer>();
  (nodeState.containers || []).forEach(container => {
    containerLookup.set(container.id, container);
  });

  const attachedContainers = (unit.associatedContainerIds || [])
    .map(containerId => containerLookup.get(containerId))
    .filter((value): value is EnrichedContainer => Boolean(value))
    .map(container => cloneContainerWithNode(container, nodeName));

  const primaryContainer = attachedContainers[0];

  let ports: ServicePort[] = [];
  if (unit.ports && unit.ports.length > 0) {
    ports = unit.ports.map(port => formatPort(port));
  } else if (primaryContainer?.ports) {
    ports = primaryContainer.ports.map(port => ({
      host: port.hostPort !== undefined ? String(port.hostPort) : '',
      container: port.containerPort !== undefined ? String(port.containerPort) : '',
    }));
  }

  const labels: Record<string, string> = { ...(primaryContainer?.labels || {}) };
  if (unit.isReverseProxy) labels['servicebay.role'] = 'reverse-proxy';
  if (unit.isServiceBay) labels['servicebay.role'] = 'system';

  let displayName = unit.name;
  if (unit.isReverseProxy) displayName = 'Reverse Proxy (Nginx)';
  else if (unit.isServiceBay) displayName = 'ServiceBay System';

  const viewModel: ServiceViewModel = {
    id: unit.name,
    name: displayName,
    nodeName,
    description: unit.description,
    active: unit.activeState === 'active',
    status: unit.activeState,
    activeState: unit.activeState,
    subState: unit.subState,
    kubePath: unit.path,
    yamlPath,
    type: isManaged ? 'kube' : 'container',
    ports,
    volumes: [],
    monitor: false,
    labels,
    verifiedDomains: unit.verifiedDomains || [],
    isManaged,
    containerIds: unit.associatedContainerIds || [],
    attachedContainers,
  };

  if (proxyRoutes && proxyRoutes.length > 0) {
    const route = proxyRoutes.find(proxyRoute => proxyRoute.targetService === baseName);
    if (route) {
      viewModel.url = `https://${route.host}`;
    }
  }

  return viewModel;
}
