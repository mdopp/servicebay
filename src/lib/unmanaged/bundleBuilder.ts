import path from 'path';
import type { ServiceUnit, EnrichedContainer, WatchedFile } from '@/lib/agent/types';
import { parseQuadletFile } from '@/lib/quadlet/parser';
import {
  BundleAsset,
  BundleContainerSummary,
  BundleGraphEdge,
  BundlePortSummary,
  BundleServiceRef,
  BundleServiceTemplate,
  BundleValidation,
  ServiceBundle,
  assetKindFromPath,
  deriveBundleDisplayName,
  generateBundleStackPreview,
  sanitizeBundleName,
  severityFromValidations
} from './bundleShared';

interface BundleBuildInput {
  nodeName: string;
  services: ServiceUnit[];
  containers: EnrichedContainer[];
  files: Record<string, WatchedFile>;
}

const EXCLUDED_UNITS = new Set([
  'podman.service',
  'podman.socket'
]);

const dedupeEdges = (edges: BundleGraphEdge[]): BundleGraphEdge[] => {
  const map = new Map<string, BundleGraphEdge>();
  edges.forEach(edge => {
    const key = `${edge.from}->${edge.to}:${edge.reason}`;
    if (!map.has(key)) {
      map.set(key, edge);
    }
  });
  return Array.from(map.values());
};

const summarizeContainer = (container: EnrichedContainer): BundleContainerSummary => {
  const safeName = (container.names[0] || container.id).replace(/^\//, '');
  return {
    id: container.id,
    name: safeName,
    image: container.image,
    state: container.state,
    podName: container.podName,
    ports: (container.ports || []).map(port => ({
      hostPort: typeof port.hostPort === 'number' ? port.hostPort : undefined,
      containerPort: typeof port.containerPort === 'number' ? port.containerPort : undefined,
      protocol: port.protocol,
      hostIp: port.hostIp
    }))
  };
};

const summarizeService = (
  service: ServiceUnit,
  nodeName: string,
  containers: Map<string, EnrichedContainer>
): BundleServiceRef => {
  const linkedContainers = (service.associatedContainerIds || [])
    .map(id => containers.get(id))
    .filter((c): c is EnrichedContainer => Boolean(c));
  const containerIds = linkedContainers.map(c => c.id);
  const containerNames = linkedContainers.map(c => (c.names[0] || c.id).replace(/^\//, ''));
  const podId = linkedContainers.find(c => c.podId)?.podId;

  const discoveryHints: string[] = [];
  if (service.path) discoveryHints.push(`Systemd unit ${service.path}`);
  if (service.fragmentPath && service.fragmentPath !== service.path) {
    discoveryHints.push(`Fragment ${service.fragmentPath}`);
  }
  linkedContainers.forEach(container => {
    const label = container.names[0] || container.id.substring(0, 12);
    discoveryHints.push(`Linked container ${label}`);
    if (container.podName) {
      discoveryHints.push(`Pod ${container.podName}`);
    }
  });

  const type = (() => {
    if (service.path?.endsWith('.kube')) return 'kube';
    if (service.path?.endsWith('.pod')) return 'pod';
    if (service.path?.endsWith('.container')) return 'container';
    return 'other';
  })();

  return {
    serviceName: service.name,
    containerNames,
    containerIds,
    podId,
    unitFile: service.fragmentPath,
    sourcePath: service.path,
    description: service.description,
    status: service.isManaged ? 'managed' : 'unmanaged',
    type,
    nodeName,
    discoveryHints
  };
};

const collectAssets = (service: ServiceUnit, files: Record<string, WatchedFile>): BundleAsset[] => {
  const assets: BundleAsset[] = [];
  const candidates = new Set<string>();

  const fileList = Object.values(files);
  const mapByPath = new Map<string, WatchedFile>();
  const normalizedPathLookup = new Map<string, string>();
  fileList.forEach(file => {
    mapByPath.set(file.path, file);
    normalizedPathLookup.set(path.normalize(file.path), file.path);
  });

  const findExistingPath = (candidate?: string | null): string | null => {
    if (!candidate) return null;
    if (mapByPath.has(candidate)) return candidate;
    const normalized = path.normalize(candidate);
    const actual = normalizedPathLookup.get(normalized);
    return actual || null;
  };

  const addPrimaryCandidate = (candidate?: string | null) => {
    if (!candidate) return;
    candidates.add(candidate);
  };

  const queue: string[] = [];
  const visited = new Set<string>();

  const enqueueExistingFile = (filePath?: string | null) => {
    const resolved = findExistingPath(filePath);
    if (!resolved || visited.has(resolved)) return;
    visited.add(resolved);
    queue.push(resolved);
    candidates.add(resolved);
  };

  // Always include the direct service paths even if the file wasn't captured yet
  addPrimaryCandidate(service.path);
  addPrimaryCandidate(service.fragmentPath);

  // Seed traversal with whichever file we can actually read
  enqueueExistingFile(service.fragmentPath || service.path);

  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    const file = mapByPath.get(currentPath);
    if (!file?.content) continue;
    let directives;
    try {
      directives = parseQuadletFile(file.content);
    } catch {
      continue;
    }

    const currentDir = path.dirname(currentPath);
    const currentExt = path.extname(currentPath).toLowerCase();
    const currentStem = path.basename(currentPath, currentExt);

    const enqueueSibling = (extension: string) => {
      if (!extension) return;
      const candidate = path.join(currentDir, `${currentStem}.${extension}`);
      enqueueExistingFile(candidate);
    };

    if (currentExt === '.pod') {
      enqueueSibling('kube');
    } else if (currentExt === '.kube') {
      enqueueSibling('pod');
    }

    const addRelativeReference = (reference?: string | null, fallbackExts: string[] = []) => {
      if (!reference) return;
      const trimmed = reference.trim();
      if (!trimmed) return;
      const nameCandidates = new Set<string>([trimmed]);
      fallbackExts.forEach(ext => {
        const lower = trimmed.toLowerCase();
        if (!lower.endsWith(`.${ext}`)) {
          nameCandidates.add(`${trimmed}.${ext}`);
        }
      });

      nameCandidates.forEach(name => {
        const target = path.isAbsolute(name) ? name : path.join(currentDir, name);
        enqueueExistingFile(target);
      });
    };

    addRelativeReference(directives?.pod || service.podReference, ['pod']);
    addRelativeReference(directives?.kubeYaml, ['yml', 'yaml']);
  }

  candidates.forEach(candidate => {
    const resolved = mapByPath.get(candidate);
    assets.push({
      path: candidate,
      kind: assetKindFromPath(candidate),
      modified: resolved?.modified
    });
  });

  return assets;
};

const parseQuadletAuthoritatively = (
  service: ServiceUnit,
  files: Record<string, WatchedFile>,
  discoveryLog: string[]
): ServiceUnit => {
  const filePath = service.fragmentPath || service.path;
  if (!filePath) return service;

  const file = files[filePath];
  if (!file || !file.content) return service;

  try {
    const parsed = parseQuadletFile(file.content);
    const updated: ServiceUnit = {
      ...service,
      requires: parsed.requires || [],
      after: parsed.after || [],
      wants: parsed.wants || [],
      bindsTo: parsed.bindsTo || [],
      podReference: parsed.pod || service.podReference,
      publishedPorts: parsed.publishPorts || service.publishedPorts,
      quadletSourceType: parsed.sourceType || service.quadletSourceType,
      description: (service.description || parsed.description) as string,
      quadletDirectives: parsed
    };

    const foundRels = (updated.requires?.length || 0) + (updated.after?.length || 0) + (updated.wants?.length || 0) + (updated.bindsTo?.length || 0);
    discoveryLog.push(`  ⚙️ Backend Quadlet parse from ${filePath} (rels=${foundRels}, pod=${updated.podReference || 'none'}, type=${updated.quadletSourceType || 'unknown'})`);
    if (updated.requires?.length) discoveryLog.push(`    Requires (parsed): ${updated.requires.join(', ')}`);
    if (updated.after?.length) discoveryLog.push(`    After (parsed): ${updated.after.join(', ')}`);
    if (updated.wants?.length) discoveryLog.push(`    Wants (parsed): ${updated.wants.join(', ')}`);
    if (updated.bindsTo?.length) discoveryLog.push(`    BindsTo (parsed): ${updated.bindsTo.join(', ')}`);

    return updated;
  } catch (err) {
    discoveryLog.push(`  ⚠ Backend Quadlet parse failed for ${filePath}: ${err}`);
    return service;
  }
};

const collectBundleKey = (
  service: ServiceUnit,
  linkedContainers: EnrichedContainer[]
): { key: string; display: string } => {
  const displayName = deriveBundleDisplayName(service.name);
  const podName = (service.podReference || '').trim() || linkedContainers.find(c => c.podName)?.podName;
  const composeProject = linkedContainers.find(c => c.labels?.['io.podman.compose.project'])?.labels?.['io.podman.compose.project'];
  const dirName = service.path ? path.basename(path.dirname(service.path)) : undefined;
  const token = sanitizeBundleName(podName || composeProject || dirName || displayName || service.name);
  const display = podName || composeProject || dirName || displayName;
  return { key: token || sanitizeBundleName(service.name), display };
};

const derivePodNameFromPath = (filePath?: string): string | undefined => {
  if (!filePath) return undefined;
  if (!filePath.endsWith('.pod')) return undefined;
  return path.basename(filePath, '.pod');
};

const getPodKeyVariants = (raw?: string | null): string[] => {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const normalized = trimmed.toLowerCase();
  const variants = new Set<string>([normalized]);
  if (normalized.startsWith('systemd-')) {
    variants.add(normalized.replace(/^systemd-/, ''));
  }
  if (normalized.endsWith('.pod')) {
    variants.add(normalized.replace(/\.pod$/, ''));
  }
  return Array.from(variants).filter(Boolean);
};

const registerPodMembership = (
  service: ServiceUnit,
  rawKey: string | null | undefined,
  servicePodKeys: Map<string, Set<string>>,
  podKeyToServices: Map<string, Set<ServiceUnit>>
): void => {
  getPodKeyVariants(rawKey).forEach(key => {
    if (!servicePodKeys.has(service.name)) {
      servicePodKeys.set(service.name, new Set());
    }
    const podSet = servicePodKeys.get(service.name)!;
    if (podSet.has(key)) return;
    podSet.add(key);
    if (!podKeyToServices.has(key)) {
      podKeyToServices.set(key, new Set());
    }
    podKeyToServices.get(key)!.add(service);
  });
};

const expandServicesByPods = (
  seed: ServiceUnit[],
  servicePodKeys: Map<string, Set<string>>,
  podKeyToServices: Map<string, Set<ServiceUnit>>,
  discoveryLog: string[]
): ServiceUnit[] => {
  if (seed.length === 0) return seed;

  const result = new Map<string, ServiceUnit>();
  const podQueue: string[] = [];
  const visitedPods = new Set<string>();

  seed.forEach(service => {
    if (!result.has(service.name)) {
      result.set(service.name, service);
    }
    servicePodKeys.get(service.name)?.forEach(podKey => {
      if (!visitedPods.has(podKey)) {
        podQueue.push(podKey);
      }
    });
  });

  while (podQueue.length > 0) {
    const podKey = podQueue.shift()!;
    if (visitedPods.has(podKey)) continue;
    visitedPods.add(podKey);
    const siblings = podKeyToServices.get(podKey);
    if (!siblings) continue;
    siblings.forEach(sibling => {
      if (result.has(sibling.name)) return;
      result.set(sibling.name, sibling);
      discoveryLog.push(`  ➕ Added ${sibling.name} via shared pod "${podKey}"`);
      servicePodKeys.get(sibling.name)?.forEach(nextPod => {
        if (!visitedPods.has(nextPod)) {
          podQueue.push(nextPod);
        }
      });
    });
  }

  if (result.size > seed.length) {
    discoveryLog.push(`Pod membership expansion added ${result.size - seed.length} service(s).`);
  }

  return Array.from(result.values());
};

const aggregatePorts = (containers: BundleContainerSummary[]): BundlePortSummary[] => {
  const seen = new Map<string, BundlePortSummary>();
  containers.forEach(container => {
    container.ports.forEach(port => {
      if (!port.hostPort && !port.containerPort) return;
      const key = `${port.hostIp || '0.0.0.0'}:${port.hostPort || port.containerPort}`;
      if (!seen.has(key)) {
        seen.set(key, { ...port });
      }
    });
  });
  return Array.from(seen.values());
};

const evaluateBundleValidations = (bundle: ServiceBundle): BundleValidation[] => {
  const validations: BundleValidation[] = [];
  if (bundle.containers.length === 0) {
    validations.push({ level: 'error', message: 'No running containers linked to this bundle' });
  }
  if (!bundle.assets.some(asset => asset.kind === 'kube' || asset.kind === 'yaml' || asset.kind === 'pod')) {
    validations.push({ level: 'warning', message: 'No Quadlet or YAML configuration detected in watched directories' });
  }
  const portKey = new Map<string, number>();
  bundle.containers.forEach(container => {
    container.ports.forEach(port => {
      if (!port.hostPort) return;
      const key = `${port.hostPort}/${port.protocol || 'tcp'}`;
      portKey.set(key, (portKey.get(key) || 0) + 1);
    });
  });
  const conflicts = Array.from(portKey.entries()).filter(([, count]) => count > 1);
  if (conflicts.length > 0) {
    conflicts.forEach(([key]) => {
      validations.push({ level: 'warning', message: `Multiple containers publish host port ${key}` });
    });
  }
  return validations;
};

const mergeBundlesByPod = (bundles: Map<string, ServiceBundle>): Map<string, ServiceBundle> => {
  const podToBundles = new Map<string, ServiceBundle[]>();
  const noPodBundles: ServiceBundle[] = [];

  // Group bundles by pod reference (extracted during bundle creation from ServiceUnit.podReference)
  bundles.forEach((bundle) => {
    const allPods = Array.from(extractPodCandidates(bundle));

    if (allPods.length > 0) {
      const podName = allPods[0]; // Use first pod if multiple
      if (!podToBundles.has(podName)) {
        podToBundles.set(podName, []);
      }
      podToBundles.get(podName)!.push(bundle);
    } else {
      noPodBundles.push(bundle);
    }
  });

  const merged = new Map<string, ServiceBundle>();

  // Merge bundles that share the same pod
  podToBundles.forEach((bundleGroup) => {
    if (bundleGroup.length === 1) {
      // No merging needed
      merged.set(bundleGroup[0].id, bundleGroup[0]);
    } else {
      // Merge all bundles in this group
      const [primary, ...rest] = bundleGroup;
      rest.forEach(bundle => {
        primary.services.push(...bundle.services);
        primary.containers = dedupeContainers([...primary.containers, ...bundle.containers]);
        primary.assets = dedupeAssets([...primary.assets, ...bundle.assets]);
        primary.graph = dedupeEdges([...primary.graph, ...bundle.graph]);
        primary.podReferences = Array.from(new Set([...(primary.podReferences || []), ...(bundle.podReferences || [])]));
        primary.serviceTemplates = dedupeServiceTemplates([
          ...(primary.serviceTemplates || []),
          ...(bundle.serviceTemplates || [])
        ]);
        bundle.hints.forEach(hint => {
          if (!primary.hints.includes(hint)) {
            primary.hints.push(hint);
          }
        });
      });
      // Final deduplication after merge
      primary.services = dedupeServices(primary.services);
      primary.containers = dedupeContainers(primary.containers);
      primary.assets = dedupeAssets(primary.assets);
      primary.graph = dedupeEdges(primary.graph);
      primary.ports = aggregatePorts(primary.containers);
      primary.podReferences = Array.from(new Set(primary.podReferences || []));
      primary.serviceTemplates = dedupeServiceTemplates(primary.serviceTemplates || []);
      // Re-evaluate validations after merge
      primary.validations = evaluateBundleValidations(primary);
      primary.severity = severityFromValidations(primary.validations);
      merged.set(primary.id, primary);
    }
  });

  // Add bundles with no pod reference
  noPodBundles.forEach(bundle => {
    merged.set(bundle.id, bundle);
  });

  return merged;
};

export const buildServiceBundlesForNode = ({ nodeName, services = [], containers = [], files = {} }: BundleBuildInput): ServiceBundle[] => {
  const containerMap = new Map<string, EnrichedContainer>();
  containers.forEach(container => containerMap.set(container.id, container));

  const drafts = new Map<string, ServiceBundle>();
  const servicePodKeys = new Map<string, Set<string>>();
  const podKeyToServices = new Map<string, Set<ServiceUnit>>();

  const registerServicePods = (svc: ServiceUnit): void => {
    registerPodMembership(svc, svc.podReference, servicePodKeys, podKeyToServices);
    registerPodMembership(svc, svc.quadletDirectives?.pod, servicePodKeys, podKeyToServices);

    const fragmentPod = derivePodNameFromPath(svc.fragmentPath);
    if (fragmentPod) registerPodMembership(svc, fragmentPod, servicePodKeys, podKeyToServices);
    const pathPod = derivePodNameFromPath(svc.path);
    if (pathPod) registerPodMembership(svc, pathPod, servicePodKeys, podKeyToServices);

    if (svc.quadletSourceType === 'pod' || fragmentPod || pathPod) {
      registerPodMembership(svc, svc.name, servicePodKeys, podKeyToServices);
    }

    (svc.associatedContainerIds || []).forEach(id => {
      const container = containerMap.get(id);
      if (!container) return;
      if (container.podId) {
        registerPodMembership(svc, `pod-id:${container.podId}`, servicePodKeys, podKeyToServices);
      }
      registerPodMembership(svc, container.podName, servicePodKeys, podKeyToServices);
      const composeProject = container.labels?.['io.podman.compose.project'];
      if (composeProject) {
        registerPodMembership(svc, composeProject, servicePodKeys, podKeyToServices);
      }
    });
  };

  services.forEach(registerServicePods);

  // --- Helper: Walk dependency graph and collect all related services ---
  const walkDependencies = (rootService: ServiceUnit, visited = new Set<string>()): ServiceUnit[] => {
    if (visited.has(rootService.name)) return [];
    visited.add(rootService.name);

    const related: ServiceUnit[] = [rootService];
    const serviceMap = new Map<string, ServiceUnit>();
    services.forEach(s => serviceMap.set(s.name, s));

    // Walk Requires (hard dependencies)
    (rootService.requires || []).forEach(req => {
      const depName = req.replace('.service', '');
      const depService = serviceMap.get(depName);
      if (depService && !visited.has(depName)) {
        related.push(...walkDependencies(depService, visited));
      }
    });

    // Walk After (ordering constraints - also indicate tight coupling)
    (rootService.after || []).forEach(aft => {
      const depName = aft.replace('.service', '');
      const depService = serviceMap.get(depName);
      if (depService && !visited.has(depName)) {
        related.push(...walkDependencies(depService, visited));
      }
    });

    // Walk Wants (soft dependencies)
    (rootService.wants || []).forEach(want => {
      const depName = want.replace('.service', '');
      const depService = serviceMap.get(depName);
      if (depService && !visited.has(depName)) {
        related.push(...walkDependencies(depService, visited));
      }
    });

    return related;
  };

  // --- Build bundles: first group by pod, then by dependencies ---
  const processedRoots = new Set<string>();
  
  // Group unmanaged services by pod reference
  const servicesByPod = new Map<string, ServiceUnit[]>();
  services
    .filter(s => !s.isManaged && !s.isServiceBay && !s.isReverseProxy && !EXCLUDED_UNITS.has(s.name))
    .forEach(service => {
      const podRef = service.podReference || 'ungrouped';
      if (!servicesByPod.has(podRef)) {
        servicesByPod.set(podRef, []);
      }
      servicesByPod.get(podRef)!.push(service);
    });

  // Log ALL services available for grouping
  const allServiceNames = services
    .filter(s => !s.isManaged && !s.isServiceBay && !s.isReverseProxy && !EXCLUDED_UNITS.has(s.name))
    .map(s => s.name);

  services
    .filter(service => !service.isManaged && !service.isServiceBay && !service.isReverseProxy && !EXCLUDED_UNITS.has(service.name))
    .forEach(service => {
      // Skip if already processed as a dependency of another service
      if (processedRoots.has(service.name)) return;

      // Walk dependency graph to get all related services
      const discoveryLog: string[] = [];
      discoveryLog.push(`═══════════════════════════════════════════════════════════`);
      discoveryLog.push(`Starting bundle discovery from root service: ${service.name}`);
      discoveryLog.push(`═══════════════════════════════════════════════════════════`);
      discoveryLog.push(``);
      discoveryLog.push(`Available services for grouping (${allServiceNames.length}):`);
      allServiceNames.forEach(name => discoveryLog.push(`  - ${name}`));
      discoveryLog.push(``);
      
      discoveryLog.push(`Root service "${service.name}" raw data:`);
      discoveryLog.push(`  path: ${service.path}`);
      discoveryLog.push(`  fragmentPath: ${service.fragmentPath}`);
      discoveryLog.push(`  requires: [${(service.requires || []).join(', ')}]`);
      discoveryLog.push(`  after: [${(service.after || []).join(', ')}]`);
      discoveryLog.push(`  wants: [${(service.wants || []).join(', ')}]`);
      discoveryLog.push(`  bindsTo: [${(service.bindsTo || []).join(', ')}]`);
      discoveryLog.push(`  podReference: ${service.podReference || 'none'}`);
      discoveryLog.push(`  quadletSourceType: ${service.quadletSourceType || 'unknown'}`);
      const serviceWithLog = service as ServiceUnit & { quadletParseLog?: string[] };
      if (serviceWithLog.quadletParseLog && Array.isArray(serviceWithLog.quadletParseLog)) {
        const tail = serviceWithLog.quadletParseLog.slice(-10);
        discoveryLog.push(`  quadletParseLog (tail):`);
        tail.forEach((entry: string) => discoveryLog.push(`    • ${entry}`));
      }
      discoveryLog.push(``);
      
      // Parse relationships from file content on the backend (authoritative single source of truth)
      const rootParsed = parseQuadletAuthoritatively(service, files, discoveryLog);

      let relatedServices = walkDependencies(rootParsed);
      relatedServices = expandServicesByPods(relatedServices, servicePodKeys, podKeyToServices, discoveryLog);
      discoveryLog.push(`Dependency graph walk found ${relatedServices.length} related service(s)`);
      discoveryLog.push(``);
      relatedServices.forEach((s, idx) => {
        discoveryLog.push(`[${idx}] Service: ${s.name}`);
        discoveryLog.push(`    requires: [${(s.requires || []).join(', ')}] (${(s.requires || []).length} items)`);
        discoveryLog.push(`    after: [${(s.after || []).join(', ')}] (${(s.after || []).length} items)`);
        discoveryLog.push(`    wants: [${(s.wants || []).join(', ')}] (${(s.wants || []).length} items)`);
        discoveryLog.push(`    bindsTo: [${(s.bindsTo || []).join(', ')}] (${(s.bindsTo || []).length} items)`);
        discoveryLog.push(`    fragmentPath: ${s.fragmentPath || 'NOT SET'}`);
        discoveryLog.push(`    containerIds: [${(s.associatedContainerIds || []).join(', ')}]`);
        const sWithLog = s as ServiceUnit & { quadletParseLog?: string[] };
        if (sWithLog.quadletParseLog && Array.isArray(sWithLog.quadletParseLog)) {
          const tail = sWithLog.quadletParseLog.slice(-5);
          discoveryLog.push(`    quadletParseLog (tail):`);
          tail.forEach((entry: string) => discoveryLog.push(`      • ${entry}`));
        }
        discoveryLog.push(``);
      });
      
      relatedServices.forEach(s => processedRoots.add(s.name));

      // Build a bundle from all related services
      const bundleServices: ServiceUnit[] = [];
      const bundleContainers: BundleContainerSummary[] = [];
      const bundleAssets: BundleAsset[] = [];
      const graphEdges: BundleGraphEdge[] = [];
      const bundleHints = new Set<string>();

      discoveryLog.push(`───────────────────────────────────────────────────────────`);
      discoveryLog.push(`Processing ${relatedServices.length} services for bundle`);
      discoveryLog.push(`───────────────────────────────────────────────────────────`);
      discoveryLog.push(``);

      relatedServices.forEach(svcOriginal => {
        const svc = parseQuadletAuthoritatively(svcOriginal, files, discoveryLog);
        discoveryLog.push(`▶ Processing service: ${svc.name}`);
        bundleServices.push(svc);
        const linkedContainers = (svc.associatedContainerIds || [])
          .map(id => containerMap.get(id))
          .filter((c): c is EnrichedContainer => Boolean(c));

        if (linkedContainers.length > 0) {
          discoveryLog.push(`  ✓ Linked ${linkedContainers.length} container(s): ${linkedContainers.map(c => c.id.substring(0, 12)).join(', ')}`);
        } else {
          discoveryLog.push(`  ℹ No running containers linked (this is normal for YAML-only services)`);
        }

        // Summarize containers
        linkedContainers.forEach(c => {
          bundleContainers.push(summarizeContainer(c));
          discoveryLog.push(`    Container: ${(c.names[0] || c.id).replace(/^\//, '')}`);
          discoveryLog.push(`      Image: ${c.image}`);
          discoveryLog.push(`      Pod: ${c.podName || 'none'}`);
        });

        // Add graph edges: service -> containers -> pod
        linkedContainers.forEach(c => {
          const containerName = (c.names[0] || c.id).replace(/^\//, '');
          graphEdges.push({
            from: svc.name,
            to: containerName,
            reason: 'Systemd → container'
          });
          discoveryLog.push(`  ⮕ Graph edge: ${svc.name} → ${containerName} [Systemd → container]`);
          
          if (c.podName) {
            graphEdges.push({
              from: containerName,
              to: c.podName,
              reason: 'Container → pod'
            });
            discoveryLog.push(`  ⮕ Graph edge: ${containerName} → ${c.podName} [Container → pod]`);
          }
        });

        // Add graph edges from discovered Quadlet relationships
        discoveryLog.push(`  Discovered Quadlet relationships:`);
        if ((svc.requires || []).length > 0) {
          svc.requires?.forEach(dep => {
            graphEdges.push({
              from: svc.name,
              to: dep,
              reason: 'Requires'
            });
            discoveryLog.push(`    ⮕ Requires: ${dep}`);
          });
        }
        if ((svc.after || []).length > 0) {
          svc.after?.forEach(dep => {
            graphEdges.push({
              from: svc.name,
              to: dep,
              reason: 'After'
            });
            discoveryLog.push(`    ⮕ After: ${dep}`);
          });
        }
        if ((svc.wants || []).length > 0) {
          svc.wants?.forEach(dep => {
            graphEdges.push({
              from: svc.name,
              to: dep,
              reason: 'Wants'
            });
            discoveryLog.push(`    ⮕ Wants: ${dep}`);
          });
        }
        if ((svc.bindsTo || []).length > 0) {
          svc.bindsTo?.forEach(dep => {
            graphEdges.push({
              from: svc.name,
              to: dep,
              reason: 'BindsTo'
            });
            discoveryLog.push(`    ⮕ BindsTo: ${dep}`);
          });
        }
        if ((svc.requires || []).length === 0 && (svc.after || []).length === 0 && (svc.wants || []).length === 0 && (svc.bindsTo || []).length === 0) {
          discoveryLog.push(`    ⚠ NO RELATIONSHIPS FOUND - Check agent parsing!`);
        }

        // Collect assets
        const assets = collectAssets(svc, files);
        bundleAssets.push(...assets);
        if (assets.length > 0) {
          discoveryLog.push(`  ✓ Collected ${assets.length} asset(s):`);
          assets.forEach(a => {
            discoveryLog.push(`    📄 ${a.path} [${a.kind}]`);
            const file = files[a.path];
            if (file?.content) {
              discoveryLog.push(`      ── file content begin ──`);
              file.content.split('\n').forEach(line => discoveryLog.push(`      | ${line}`));
              discoveryLog.push(`      ── file content end ──`);
            } else {
              discoveryLog.push(`      (content not available in watched files map)`);
            }
          });
        } else {
          discoveryLog.push(`  ⚠ NO ASSETS COLLECTED`);
          discoveryLog.push(`    fragmentPath: ${svc.fragmentPath || 'NOT SET'}`);
          discoveryLog.push(`    path: ${svc.path || 'NOT SET'}`);
          if (!svc.fragmentPath && !svc.path) {
            discoveryLog.push(`    ❌ Both fragmentPath and path are empty - agent needs to set fragmentPath!`);
          }
        }
        discoveryLog.push(``);

        // Add discovery hints from relationships
        if ((svc.requires || []).length > 0) {
          bundleHints.add(`Hard dependencies: ${(svc.requires || []).join(', ')}`);
        }
        if ((svc.after || []).length > 0) {
          bundleHints.add(`Ordered after: ${(svc.after || []).join(', ')}`);
        }
        if ((svc.wants || []).length > 0) {
          bundleHints.add(`Soft dependencies: ${(svc.wants || []).join(', ')}`);
        }
        if ((svc.bindsTo || []).length > 0) {
          bundleHints.add(`Binding relationships: ${(svc.bindsTo || []).join(', ')}`);
        }
        if ((svc.publishedPorts || []).length > 0) {
          const portDescs = (svc.publishedPorts || [])
            .map(p => `${p.hostPort || p.containerPort}/${p.protocol || 'tcp'}`)
            .join(', ');
          bundleHints.add(`Published ports: ${portDescs}`);
        }
      });

      // Use the root service for the bundle key
      const linkedContainers = (service.associatedContainerIds || [])
        .map(id => containerMap.get(id))
        .filter((c): c is EnrichedContainer => Boolean(c));
      const { key: initialKey, display: initialDisplay } = collectBundleKey(service, linkedContainers);

      const podRefs = new Set<string>();
      bundleServices.forEach(svc => {
        const ref = svc.podReference?.trim();
        if (ref) {
          podRefs.add(ref);
        }
      });

      let derivedName = initialKey;
      let displayName = initialDisplay || service.name;
      const primaryPodName = Array.from(podRefs)[0];
      if (primaryPodName) {
        displayName = primaryPodName;
        const sanitizedPod = sanitizeBundleName(primaryPodName);
        if (sanitizedPod) {
          derivedName = sanitizedPod;
        }
      }

      const bundleId = `${nodeName}::${derivedName}`;

      // Deduplicate containers and assets
      const deduped = dedupeContainers(bundleContainers);
      const dedupedAssets = dedupeAssets(bundleAssets);
      const rawTemplates = bundleServices
        .map(extractServiceTemplate)
        .filter((template): template is BundleServiceTemplate => Boolean(template));
      const serviceTemplates = dedupeServiceTemplates(rawTemplates);

      if (bundleServices.length === 0) {
        bundleHints.add('No matching Quadlet files were found in watched directories');
      }
      if (deduped.some(c => c.podName)) {
        bundleHints.add('Containers share Pod context');
      }

      discoveryLog.push(`═══════════════════════════════════════════════════════════`);
      discoveryLog.push(`BUNDLE SUMMARY`);
      discoveryLog.push(`═══════════════════════════════════════════════════════════`);
      discoveryLog.push(`Bundle ID: ${bundleId}`);
      discoveryLog.push(`Display Name: ${displayName}`);
      discoveryLog.push(`Total Services: ${bundleServices.length}`);
      discoveryLog.push(`Total Containers: ${deduped.length}`);
      discoveryLog.push(`Total Assets: ${dedupedAssets.length}`);
      discoveryLog.push(`Total Graph Edges: ${dedupeEdges(graphEdges).length}`);
      discoveryLog.push(`Total Hints: ${bundleHints.size}`);
      discoveryLog.push(``);

      // Extract pod references from services
      if (bundleServices.length === 1 && relatedServices.length > 1) {
        discoveryLog.push(`⚠ WARNING: Started with ${relatedServices.length} services but ended with ${bundleServices.length}`);
        discoveryLog.push(`   This suggests services were found but not all were added to the bundle`);
      }
      if (dedupedAssets.length === 0) {
        discoveryLog.push(`❌ ERROR: No assets collected! Agent must set fragmentPath on ServiceUnit`);
      }
      if (dedupeEdges(graphEdges).length === 0) {
        discoveryLog.push(`⚠ WARNING: No graph edges! Check if services have relationship fields set`);
      }
      discoveryLog.push(`═══════════════════════════════════════════════════════════`);

      const bundle: ServiceBundle = {
        id: bundleId,
        displayName,
        derivedName,
        nodeName,
        severity: 'info',
        hints: Array.from(bundleHints),
        validations: [],
        services: bundleServices.map(svc => summarizeService(svc, nodeName, containerMap)),
        containers: deduped,
        ports: aggregatePorts(deduped),
        assets: dedupedAssets,
        graph: dedupeEdges(graphEdges),
        podReferences: Array.from(podRefs),
        discoveryLog,
        serviceTemplates
      };
      bundle.validations = evaluateBundleValidations(bundle);
      bundle.severity = severityFromValidations(bundle.validations);

      drafts.set(bundleId, bundle);
    });

  // --- Merge bundles that share the same pod reference ---
  const mergedDrafts = mergeBundlesByPod(drafts);
  const baseBundles = Array.from(mergedDrafts.values());
  const orphanPodBundles = buildSyntheticPodBundles(nodeName, baseBundles, services, containers, files, containerMap);
  const allBundles = [...baseBundles, ...orphanPodBundles];

  return allBundles.sort((a, b) => {
    if (a.severity === b.severity) {
      return a.displayName.localeCompare(b.displayName);
    }
    const order: Record<ServiceBundle['severity'], number> = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
};

  const buildSyntheticPodBundles = (
    nodeName: string,
    existingBundles: ServiceBundle[],
    services: ServiceUnit[],
    containers: EnrichedContainer[],
    files: Record<string, WatchedFile>,
    containerMap: Map<string, EnrichedContainer>
  ): ServiceBundle[] => {
    const podsToContainers = new Map<string, {
      normalized: string;
      displayName: string;
      rawNames: Set<string>;
      containers: EnrichedContainer[];
    }>();

    containers.forEach(container => {
      const podName = resolveContainerPodName(container);
      if (!podName) return;
      const normalized = normalizePodKey(podName);
      if (!normalized) return;
      if (!podsToContainers.has(normalized)) {
        podsToContainers.set(normalized, {
          normalized,
          displayName: sanitizePodDisplayName(podName),
          rawNames: new Set<string>(),
          containers: []
        });
      }
      const entry = podsToContainers.get(normalized)!;
      entry.rawNames.add(podName);
      if (!entry.displayName) {
        entry.displayName = sanitizePodDisplayName(podName);
      }
      entry.containers.push(container);
    });

    if (podsToContainers.size === 0) {
      return [];
    }

    const podsWithManagedService = new Set<string>();
    services.forEach(service => {
      if (!service.isManaged) return;
      collectPodKeysForService(service, containerMap).forEach(key => podsWithManagedService.add(key));
    });

    const podsAlreadyBundled = new Set<string>();
    existingBundles.forEach(bundle => {
      (bundle.podReferences || []).forEach(ref => {
        const normalized = normalizePodKey(ref);
        if (normalized) podsAlreadyBundled.add(normalized);
      });
      bundle.containers.forEach(container => {
        const normalized = normalizePodKey(container.podName);
        if (normalized) podsAlreadyBundled.add(normalized);
      });
    });

    const orphanBundles: ServiceBundle[] = [];

    podsToContainers.forEach(entry => {
      if (podsWithManagedService.has(entry.normalized)) return;
      if (podsAlreadyBundled.has(entry.normalized)) return;

      const canonicalName = Array.from(entry.rawNames)[0] || entry.displayName || entry.normalized;
      const serviceName = canonicalName || `${entry.normalized}.pod`;
      const friendlyLabel = sanitizePodDisplayName(entry.displayName || canonicalName) || serviceName || entry.normalized;
      const containerSummaries = entry.containers.map(summarizeContainer);
      const bundlePorts = aggregatePorts(containerSummaries);
      const bundleAssets = collectPodAssets(canonicalName, files);
      const definitionAsset = bundleAssets.find(asset => asset.kind === 'pod')
        || bundleAssets.find(asset => asset.kind === 'kube' || asset.kind === 'yaml');

      const discoveryHints = [
        `Pod "${friendlyLabel}" is running ${containerSummaries.length} container(s) without a managed service`,
        `Containers: ${containerSummaries.map(summary => summary.name).join(', ')}`
      ];

      const syntheticService: BundleServiceRef = {
        serviceName,
        containerNames: containerSummaries.map(summary => summary.name),
        containerIds: containerSummaries.map(summary => summary.id),
        podId: entry.containers.find(c => c.podId)?.podId,
        unitFile: definitionAsset?.path,
        sourcePath: definitionAsset?.path,
        description: 'Synthetic bundle generated from orphaned pod',
        status: 'unmanaged',
        type: 'pod',
        nodeName,
        discoveryHints
      };

      const graphEdges: BundleGraphEdge[] = containerSummaries.map(summary => ({
        from: serviceName,
        to: summary.name,
        reason: 'Pod → container'
      }));

      const hints = [
        'Detected Pod without ServiceBay-managed unit',
        `Containers: ${containerSummaries.map(summary => summary.name).join(', ')}`
      ];

      const validations: BundleValidation[] = [{
        level: 'warning',
        message: 'No managing service controls this pod'
      }];

      const derivedName = sanitizeBundleName(friendlyLabel) || `pod-${entry.normalized}`;
      const bundleId = `${nodeName}::pod-${derivedName}`;

      orphanBundles.push({
        id: bundleId,
        displayName: friendlyLabel,
        derivedName,
        nodeName,
        severity: severityFromValidations(validations),
        hints,
        validations,
        services: [syntheticService],
        containers: containerSummaries,
        ports: bundlePorts,
        assets: bundleAssets,
        graph: graphEdges,
        podReferences: Array.from(entry.rawNames),
        discoveryLog: [
          `Synthetic pod bundle created for ${friendlyLabel}`,
          `Containers captured: ${containerSummaries.length}`
        ]
      });
    });

    return orphanBundles;
  };

  const collectPodKeysForService = (
    service: ServiceUnit,
    containerMap: Map<string, EnrichedContainer>
  ): Set<string> => {
    const keys = new Set<string>();
    [
      service.podReference,
      service.quadletDirectives?.pod,
      derivePodNameFromPath(service.fragmentPath),
      derivePodNameFromPath(service.path),
      service.name
    ].forEach(value => {
      const normalized = normalizePodKey(value);
      if (normalized) keys.add(normalized);
    });

    (service.associatedContainerIds || []).forEach(id => {
      const container = containerMap.get(id);
      const normalized = normalizePodKey(resolveContainerPodName(container));
      if (normalized) keys.add(normalized);
    });

    return keys;
  };

  const resolveContainerPodName = (container?: EnrichedContainer | null): string | null => {
    if (!container) return null;
    return container.podName || container.labels?.['io.podman.pod.name'] || container.labels?.['io.kubernetes.pod.name'] || null;
  };

  const sanitizePodDisplayName = (value: string): string => {
    if (!value) return '';
    const trimmed = value.replace(/^systemd-/, '');
    return trimmed.replace(/\.pod$/i, '') || value;
  };

  const normalizePodKey = (value?: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    let normalized = sanitizeBundleName(trimmed);
    if (!normalized) normalized = trimmed;
    normalized = normalized.replace(/^systemd-/, '');
    normalized = normalized.replace(/-pod$/, '');
    return normalized || null;
  };

  const collectPodAssets = (podName: string, files: Record<string, WatchedFile>): BundleAsset[] => {
    const normalizedTarget = normalizePodKey(podName);
    const assets: BundleAsset[] = [];
    Object.values(files || {}).forEach(file => {
      if (!file?.path) return;
      const base = path.basename(file.path);
      const stem = base.replace(/\.(pod|kube|yaml|yml|container)$/i, '');
      const normalizedStem = normalizePodKey(stem);
      if (normalizedTarget && normalizedStem && normalizedStem === normalizedTarget) {
        assets.push({ path: file.path, kind: assetKindFromPath(file.path), modified: file.modified });
        return;
      }
      if (normalizedTarget && file.path.toLowerCase().includes(normalizedTarget)) {
        assets.push({ path: file.path, kind: assetKindFromPath(file.path), modified: file.modified });
      }
    });
    return dedupeAssets(assets);
  };

const dedupeContainers = (containers: BundleContainerSummary[]): BundleContainerSummary[] => {
  const map = new Map<string, BundleContainerSummary>();
  containers.forEach(container => {
    map.set(container.id, container);
  });
  return Array.from(map.values());
};

const dedupeAssets = (assets: BundleAsset[]): BundleAsset[] => {
  const map = new Map<string, BundleAsset>();
  assets.forEach(asset => {
    map.set(asset.path, asset);
  });
  return Array.from(map.values());
};

const dedupeServices = (services: BundleServiceRef[]): BundleServiceRef[] => {
  const map = new Map<string, BundleServiceRef>();
  services.forEach(service => {
    map.set(service.serviceName, service);
  });
  return Array.from(map.values());
};

const mergeUniqueStrings = (...lists: Array<string[] | undefined>): string[] | undefined => {
  const combined: string[] = [];
  lists.forEach(list => {
    if (!list) return;
    list.forEach(entry => {
      if (entry && entry.length > 0) {
        combined.push(entry);
      }
    });
  });
  if (combined.length === 0) return undefined;
  return Array.from(new Set(combined));
};

const extractServiceTemplate = (service: ServiceUnit): BundleServiceTemplate | null => {
  const directives = service.quadletDirectives;
  if (!directives) return null;
  const hasEnvironment = directives.environment && Object.keys(directives.environment).length > 0;
  const hasPayload = Boolean(
    directives.containerName ||
    directives.image ||
    hasEnvironment ||
    (directives.environmentFiles && directives.environmentFiles.length > 0) ||
    (directives.volumes && directives.volumes.length > 0)
  );
  if (!hasPayload) return null;
  return {
    serviceName: service.name,
    containerName: directives.containerName,
    image: directives.image,
    environment: hasEnvironment ? { ...directives.environment } : undefined,
    environmentFiles: mergeUniqueStrings(directives.environmentFiles),
    volumes: mergeUniqueStrings(directives.volumes)
  };
};

const dedupeServiceTemplates = (templates: BundleServiceTemplate[] = []): BundleServiceTemplate[] => {
  const map = new Map<string, BundleServiceTemplate>();
  templates.forEach(template => {
    const existing = map.get(template.serviceName);
    if (!existing) {
      map.set(template.serviceName, {
        ...template,
        environment: template.environment ? { ...template.environment } : undefined,
        environmentFiles: mergeUniqueStrings(template.environmentFiles),
        volumes: mergeUniqueStrings(template.volumes)
      });
      return;
    }
    map.set(template.serviceName, {
      serviceName: template.serviceName,
      containerName: template.containerName || existing.containerName,
      image: template.image || existing.image,
      environment: template.environment || existing.environment
        ? { ...(existing.environment || {}), ...(template.environment || {}) }
        : undefined,
      environmentFiles: mergeUniqueStrings(existing.environmentFiles, template.environmentFiles),
      volumes: mergeUniqueStrings(existing.volumes, template.volumes)
    });
  });
  return Array.from(map.values());
};

const extractPodCandidates = (bundle: ServiceBundle): Set<string> => {
  const pods = new Set<string>();

  // Primary: explicit pod references collected from ServiceUnit parsing
  (bundle.podReferences || []).forEach(p => pods.add(p));

  // Secondary: pod name on containers
  bundle.containers.forEach(container => {
    if (container.podName) pods.add(container.podName);
  });

  // Tertiary: edges that point to pods
  bundle.graph
    .filter(edge => edge.reason === 'Container → pod')
    .forEach(edge => pods.add(edge.to));

  // Pod assets (.pod files) imply the pod name
  bundle.assets
    .filter(asset => asset.path.endsWith('.pod'))
    .forEach(asset => pods.add(path.basename(asset.path, '.pod')));

  // If the displayName looks like the pod name (pod bundles), use it
  if (bundle.displayName) pods.add(bundle.displayName);

  return pods;
};

// @knipignore - exported for potential UI/API use to generate bundle preview YAML
export const ensureBundlePreview = (bundle: ServiceBundle, targetName?: string): string => {
  return generateBundleStackPreview(bundle, targetName || bundle.displayName);
};
