import yaml from 'js-yaml';

export type BundleAssetKind = 'kube' | 'container' | 'service' | 'pod' | 'yaml' | 'config' | 'unknown';

export interface BundleAsset {
  path: string;
  kind: BundleAssetKind;
  modified?: number;
  note?: string;
}

export interface BundleValidation {
  level: 'info' | 'warning' | 'error';
  message: string;
  scope?: string;
}

export interface BundlePortSummary {
  hostPort?: number;
  containerPort?: number;
  protocol?: string;
  hostIp?: string;
}

export interface BundleContainerSummary {
  id: string;
  name: string;
  image: string;
  state?: string;
  podName?: string;
  ports: BundlePortSummary[];
}

export interface BundleServiceRef {
  serviceName: string;
  containerNames: string[];
  containerIds: string[];
  podId?: string;
  unitFile?: string;
  sourcePath?: string;
  description?: string;
  status: 'managed' | 'unmanaged';
  type: 'kube' | 'container' | 'pod' | 'compose' | 'other';
  nodeName: string;
  discoveryHints: string[];
}

export interface BundleGraphEdge {
  from: string;
  to: string;
  reason: string;
}

export interface ServiceBundle {
  id: string;
  displayName: string;
  derivedName: string;
  nodeName: string;
  severity: 'info' | 'warning' | 'critical';
  hints: string[];
  validations: BundleValidation[];
  services: BundleServiceRef[];
  containers: BundleContainerSummary[];
  ports: BundlePortSummary[];
  assets: BundleAsset[];
  graph: BundleGraphEdge[];
  discoveryLog?: string[];
}

export interface BundleStackContainer {
  name: string;
  image: string;
  role: 'primary' | 'sidecar';
  ports: BundlePortSummary[];
}

export interface BundleStackArtifacts {
  name: string;
  kubeUnit: string;
  podYaml: string;
  containers: BundleStackContainer[];
  configPaths: string[];
}

export const sanitizeBundleName = (value: string): string => {
  return value
    .replace(/\.service$/i, '')
    .replace(/[^a-zA-Z0-9-.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
};

export const deriveBundleDisplayName = (serviceName: string): string => {
  const base = serviceName.replace(/\.service$/i, '');
  if (base.includes('@')) {
    return base.split('@')[0];
  }
  return base;
};

export const assetKindFromPath = (filePath: string): BundleAssetKind => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.kube')) return 'kube';
  if (lower.endsWith('.container')) return 'container';
  if (lower.endsWith('.service')) return 'service';
  if (lower.endsWith('.pod')) return 'pod';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.env') || lower.includes('/config/')) return 'config';
  return 'unknown';
};

export const generateBundleStackArtifacts = (bundle: ServiceBundle, targetName?: string): BundleStackArtifacts => {
  const fallbackName = bundle.displayName || bundle.derivedName || bundle.id || 'bundle';
  const safeName = sanitizeBundleName(targetName || fallbackName) || sanitizeBundleName(fallbackName) || 'bundle';

  const containers = bundle.containers.length > 0
    ? bundle.containers
    : [{ id: 'placeholder', name: fallbackName, image: 'replace/me', ports: [] }];

  const stackContainers: BundleStackContainer[] = containers.map((container, index) => ({
    name: sanitizeBundleName(container.name || container.id) || `container-${index + 1}`,
    image: container.image || 'replace/me',
    role: index === 0 ? 'primary' : 'sidecar',
    ports: container.ports || []
  }));

  const podSpec = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: safeName,
      labels: {
        'servicebay.io/source': 'bundle-generator',
        'servicebay.io/bundle-id': bundle.id,
        'servicebay.io/origin': bundle.displayName
      },
      annotations: {
        'servicebay.io/node': bundle.nodeName
      }
    },
    spec: {
      restartPolicy: 'Always',
      containers: stackContainers.map(container => ({
        name: container.name,
        image: container.image,
        ports: container.ports.length > 0
          ? container.ports.map(port => ({
              containerPort: port.containerPort ?? port.hostPort,
              hostPort: port.hostPort,
              protocol: port.protocol || 'tcp'
            }))
          : undefined
      }))
    }
  };

  const kubeUnit = `[Unit]\nDescription=ServiceBay managed stack ${bundle.displayName || safeName}\nAfter=network-online.target\n\n[Kube]\nYaml=${safeName}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target\n`;

  const configPaths = bundle.assets
    .filter(asset => asset.kind === 'config' || /\.env$/i.test(asset.path))
    .map(asset => asset.path)
    .sort();

  return {
    name: safeName,
    kubeUnit: kubeUnit.trim(),
    podYaml: yaml.dump(podSpec),
    containers: stackContainers,
    configPaths
  };
};

export const generateBundleStackPreview = (bundle: ServiceBundle, targetName?: string): string => {
  const artifacts = generateBundleStackArtifacts(bundle, targetName);
  const configSection = artifacts.configPaths.length > 0
    ? `\n---\n# Config/file references\n${artifacts.configPaths.map(path => `# - ${path}`).join('\n')}\n`
    : '\n';
  return `# Quadlet (.kube) suggestion\n${artifacts.kubeUnit}\n\n---\n# Pod specification\n${artifacts.podYaml}${configSection}`;
};

export const severityFromValidations = (validations: BundleValidation[]): ServiceBundle['severity'] => {
  if (validations.some(v => v.level === 'error')) {
    return 'critical';
  }
  if (validations.some(v => v.level === 'warning')) {
    return 'warning';
  }
  return 'info';
};
