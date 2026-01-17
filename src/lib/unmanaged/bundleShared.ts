import path from 'path';
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

export interface BundleServiceTemplate {
  serviceName: string;
  containerName?: string;
  image?: string;
  environment?: Record<string, string>;
  environmentFiles?: string[];
  volumes?: string[];
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
  podReferences?: string[]; // Pod names this bundle's services reference (for grouping)
  discoveryLog?: string[];
  serviceTemplates?: BundleServiceTemplate[];
}

export interface BundleStackContainer {
  name: string;
  image: string;
  role: 'primary' | 'sidecar';
  ports: BundlePortSummary[];
  env?: Array<{ name: string; value: string }>;
  envFrom?: Array<{ configMapRef?: { name: string }; secretRef?: { name: string } }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
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

  const serviceTemplates = bundle.serviceTemplates || [];
  const templateMap = new Map<string, BundleServiceTemplate>();
  serviceTemplates.forEach(template => {
    const key = sanitizeBundleName(template.containerName || template.serviceName);
    if (!key) return;
    if (!templateMap.has(key)) {
      templateMap.set(key, template);
    }
  });

  const configPathsSet = new Set(
    bundle.assets
      .filter(asset => asset.kind === 'config' || /\.env$/i.test(asset.path))
      .map(asset => asset.path)
  );
  serviceTemplates.forEach(template => {
    (template.environmentFiles || []).forEach(filePath => {
      if (filePath) {
        configPathsSet.add(filePath);
      }
    });
  });

  const ensureUniqueName = (value: string | undefined, used: Set<string>, fallbackPrefix: string): string => {
    const base = (value && value.length > 0 ? value : fallbackPrefix).toLowerCase();
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${counter++}`;
    }
    used.add(candidate);
    return candidate;
  };

  const parseVolumeDirective = (entry: string): { hostPath?: string; containerPath?: string; readOnly?: boolean } | null => {
    if (!entry) return null;
    const normalized = entry.trim();
    // Support key=value syntax
    if (normalized.includes('=')) {
      const parts = normalized.split(',');
      const kv: Record<string, string> = {};
      parts.forEach(part => {
        const [k, ...vParts] = part.split('=');
        if (!k) return;
        kv[k.trim().toLowerCase()] = vParts.join('=');
      });
      const source = kv.source || kv.src || kv.host || kv.hostpath;
      const destination = kv.destination || kv.dest || kv.target || kv.container || kv.dir || kv.containerpath;
      const options = kv.options || kv.mode;
      const readOnly = typeof kv.readonly !== 'undefined'
        ? kv.readonly === 'true' || kv.readonly === '1'
        : (options || '').split(',').some(opt => opt.trim().toLowerCase() === 'ro');
      if (source && destination) {
        return {
          hostPath: source,
          containerPath: destination,
          readOnly
        };
      }
    }

    // Fallback to colon-delimited syntax
    const colonParts = normalized.split(':');
    if (colonParts.length >= 2) {
      const hostPath = colonParts[0];
      const containerPath = colonParts[1];
      const options = colonParts.slice(2).join(':');
      const readOnly = options.split(',').some(opt => opt.trim().toLowerCase() === 'ro');
      return { hostPath, containerPath, readOnly };
    }
    return null;
  };

  type IntermediateContainer = {
    name: string;
    image: string;
    ports: BundlePortSummary[];
    env?: Array<{ name: string; value: string }>;
    envFrom?: Array<{ configMapRef?: { name: string } }>;
    volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  };

  const finalContainers: IntermediateContainer[] = [];
  const processedKeys = new Set<string>();
  const usedContainerNames = new Set<string>();
  const usedConfigMapNames = new Set<string>();
  const usedVolumeNames = new Set<string>();
  const hostPathToVolumeName = new Map<string, string>();
  const volumeDefinitions = new Map<string, { name: string; hostPath: string }>();

  const ensureVolumeName = (hostPath: string, suggested: string): string => {
    if (hostPath && hostPathToVolumeName.has(hostPath)) {
      return hostPathToVolumeName.get(hostPath)!;
    }
    const uniqueName = ensureUniqueName(sanitizeBundleName(suggested), usedVolumeNames, 'volume');
    if (hostPath) {
      hostPathToVolumeName.set(hostPath, uniqueName);
      volumeDefinitions.set(uniqueName, { name: uniqueName, hostPath });
    }
    return uniqueName;
  };

  const buildContainerSpec = (
    key: string,
    container: BundleContainerSummary | undefined,
    template: BundleServiceTemplate | undefined,
    fallbackIndex: number
  ): IntermediateContainer => {
    const baseName = sanitizeBundleName(
      (template?.containerName || container?.name || container?.id || template?.serviceName || `${fallbackName}-${fallbackIndex + 1}`)
    );
    const name = ensureUniqueName(baseName, usedContainerNames, `container-${fallbackIndex + 1}`);
    const ports = container?.ports?.length ? container.ports : [];
    const image = container?.image || template?.image || 'replace/me';
    const envEntries = template?.environment
      ? Object.entries(template.environment).map(([envName, value]) => ({ name: envName, value: value ?? '' }))
      : undefined;

    const envFromEntries = template?.environmentFiles?.map((filePath, idx) => ({
      configMapRef: {
        name: ensureUniqueName(
          sanitizeBundleName(path.basename(filePath) || `${name}-env-${idx + 1}`),
          usedConfigMapNames,
          `${name}-env-${idx + 1}`
        )
      }
    }));

    const volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> = [];
    (template?.volumes || []).forEach((entry, volIdx) => {
      const parsed = parseVolumeDirective(entry);
      if (!parsed?.hostPath || !parsed.containerPath) return;
      const volumeName = ensureVolumeName(
        parsed.hostPath,
        `${name}-${path.basename(parsed.containerPath) || 'volume'}-${volIdx + 1}`
      );
      volumeMounts.push({ name: volumeName, mountPath: parsed.containerPath, readOnly: parsed.readOnly });
    });

    return {
      name,
      image,
      ports,
      env: envEntries,
      envFrom: envFromEntries,
      volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined
    };
  };

  // Start with discovered runtime containers
  bundle.containers.forEach((containerSummary, idx) => {
    const key = sanitizeBundleName(containerSummary.name || containerSummary.id) || `runtime-${idx + 1}`;
    const template = templateMap.get(key);
    processedKeys.add(key);
    finalContainers.push(buildContainerSpec(key, containerSummary, template, idx));
  });

  // Add templates with no runtime containers so every service appears in the pod spec
  serviceTemplates.forEach((template, idx) => {
    const key = sanitizeBundleName(template.containerName || template.serviceName) || `template-${idx + 1}`;
    if (processedKeys.has(key)) return;
    processedKeys.add(key);
    finalContainers.push(buildContainerSpec(key, undefined, template, bundle.containers.length + idx));
  });

  // Ensure every service is represented even if no runtime container or parsed template exists
  bundle.services.forEach((svc, idx) => {
    const key = sanitizeBundleName(svc.serviceName || `service-${idx + 1}`) || `service-${idx + 1}`;
    if (processedKeys.has(key)) return;
    processedKeys.add(key);
    finalContainers.push(buildContainerSpec(
      key,
      undefined,
      { serviceName: svc.serviceName },
      bundle.containers.length + serviceTemplates.length + idx
    ));
  });

  // Final fallback if everything was empty
  if (finalContainers.length === 0) {
    finalContainers.push(buildContainerSpec('fallback', undefined, undefined, 0));
  }

  const stackContainers: BundleStackContainer[] = finalContainers.map((container, index) => ({
    name: container.name,
    image: container.image,
    role: index === 0 ? 'primary' : 'sidecar',
    ports: container.ports || [],
    env: container.env,
    envFrom: container.envFrom,
    volumeMounts: container.volumeMounts
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
          : undefined,
        env: container.env,
        envFrom: container.envFrom,
        volumeMounts: container.volumeMounts
      })),
      volumes: volumeDefinitions.size > 0
        ? Array.from(volumeDefinitions.values()).map(volume => ({
            name: volume.name,
            hostPath: {
              path: volume.hostPath
            }
          }))
        : undefined
    }
  };

  const kubeUnit = `[Unit]\nDescription=ServiceBay managed stack ${bundle.displayName || safeName}\nAfter=network-online.target\n\n[Kube]\nYaml=${safeName}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target\n`;
  const configPaths = Array.from(configPathsSet).sort();

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
