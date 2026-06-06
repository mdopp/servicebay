import type { ServiceUnit, EnrichedContainer, ProxyRoute } from '@/lib/agent/types';
import type { NodeTwin } from '@/lib/store/twin';
import { parseTemplateLabel } from '@/lib/templateLabel';
// Direct sub-path import — using the barrel would create a cycle since
// api-client/index re-exports `buildServiceViewModel` from this file.
import type { ServiceViewModel, ServicePort } from '@servicebay/api-client/serviceView';

interface BuildServiceViewModelArgs {
  unit: ServiceUnit;
  nodeName: string;
  nodeState: NodeTwin;
  proxyRoutes?: ProxyRoute[];
  /**
   * Base names of services ServiceBay installed (config.installedTemplates
   * keys). #1733: a unit whose base name is in this set is treated as managed
   * even when it isn't backed by a `.kube`/pod — e.g. a single-container
   * `.container` Quadlet (the ollama GPU fixup), which would otherwise be
   * classified Standalone/unmanaged.
   */
  installedTemplates?: Iterable<string>;
}

const formatPort = (port?: { hostPort?: number; containerPort?: number }): ServicePort => ({
  host: port?.hostPort !== undefined ? String(port.hostPort) : '',
  container: port?.containerPort !== undefined ? String(port.containerPort) : '',
});

const cloneContainerWithNode = (container: EnrichedContainer, nodeName: string): EnrichedContainer => ({
  ...container,
  nodeName,
});

export function buildServiceViewModel({ unit, nodeName, nodeState, proxyRoutes, installedTemplates }: BuildServiceViewModelArgs): ServiceViewModel | null {
  const fileKeys = Object.keys(nodeState.files || {});
  const baseName = unit.name.replace('.service', '');

  // #1733: managed if the agent flagged it (.kube/.container) OR its base name
  // is one ServiceBay installed. The latter rescues a single-container
  // .container Quadlet (ollama GPU fixup) with no pod from being treated as a
  // bare container in the UI.
  const installedSet = installedTemplates ? new Set(installedTemplates) : null;
  const isManaged = Boolean(unit.isManaged) || Boolean(installedSet?.has(baseName));

  if (!isManaged && !unit.isReverseProxy && !unit.isServiceBay) {
    return null;
  }

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
    } else {
      // #1733: no .kube chain — a single-container .container Quadlet (e.g.
      // ollama). Fall back to the .yml/.yaml pod manifest if one happens to
      // sit alongside (label/port hints); the .container itself has no
      // servicebay.label so displayName stays the base name.
      const fallbackYaml = fileKeys.find(key => key.endsWith(`/${baseName}.yml`) || key.endsWith(`/${baseName}.yaml`));
      if (fallbackYaml) {
        yamlPath = fallbackYaml;
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

  // Backend-computed display fields (#844 / ARCH-12). The frontend used
  // to derive these with `.replace('.service', '')` and `.split('/').pop()`
  // — those rules belong here so every consumer sees the same answer.
  //
  // Label resolution order (most → least specific):
  //   1. Hard-coded special cases (reverse-proxy / servicebay-system).
  //   2. `servicebay.label` parsed from the deployed YAML, when it's
  //      already in the twin's file watcher (kube-managed services).
  //   3. Fallback to `baseName` (the unit name minus `.service`).
  //
  // Step 2 is what makes the /services dashboard render the same
  // user-friendly labels the portal shows ("Photos" instead of
  // "immich", "Smart Home (Home Assistant)" instead of "home-assistant").
  // The YAML content is already in nodeState.files from the file
  // watcher; no extra I/O.
  let displayName = baseName;
  let legacyName = unit.name;
  if (unit.isReverseProxy) {
    displayName = 'Reverse Proxy (Nginx)';
    legacyName = displayName;
  } else if (unit.isServiceBay) {
    displayName = 'ServiceBay System';
    legacyName = displayName;
  } else if (yamlPath) {
    const yamlFile = nodeState.files?.[yamlPath];
    if (yamlFile?.content) {
      const label = parseTemplateLabel(yamlFile.content);
      if (label && label.trim()) {
        displayName = label.trim();
      }
    }
  }

  const yamlBasename = yamlPath ? (yamlPath.split('/').pop() ?? null) : null;
  const kubeBasename = unit.path ? (unit.path.split('/').pop() ?? null) : null;

  // Note on `name` vs `displayName`: historically `name` held the unit
  // identifier (e.g. `vaultwarden.service`) for normal rows but the
  // human label (e.g. `Reverse Proxy (Nginx)`) for the special
  // overrides. That overload is what callers compensated for with
  // `.replace('.service', '')`. New code should read `displayName`
  // (always the rendered string) and `id` (always the unit name);
  // `name` keeps its legacy shape so the migration stays incremental. (#844)
  const viewModel: ServiceViewModel = {
    id: unit.name,
    name: legacyName,
    displayName,
    yamlBasename,
    kubeBasename,
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
