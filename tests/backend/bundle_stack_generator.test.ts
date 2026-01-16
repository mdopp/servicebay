import { describe, it, expect } from 'vitest';
import { generateBundleStackArtifacts, ServiceBundle } from '@/lib/unmanaged/bundleShared';

const baseBundle: ServiceBundle = {
  id: 'bundle-001',
  displayName: 'Example App',
  derivedName: 'example-app',
  nodeName: 'Local',
  severity: 'info',
  hints: [],
  validations: [],
  services: [],
  containers: [
    {
      id: 'abc123',
      name: 'api',
      image: 'ghcr.io/example/api:latest',
      ports: [{ containerPort: 8080, hostPort: 18080, protocol: 'tcp' }]
    }
  ],
  ports: [],
  assets: [
    { path: '/opt/example/.env', kind: 'config' },
    { path: '/opt/example/docker-compose.yml', kind: 'yaml' }
  ],
  graph: []
};

describe('generateBundleStackArtifacts', () => {
  it('sanitizes the target name and wires it into the kube unit', () => {
    const artifacts = generateBundleStackArtifacts(baseBundle, 'My App Stack!!');
    expect(artifacts.name).toBe('my-app-stack');
    expect(artifacts.kubeUnit).toContain('Yaml=my-app-stack.yml');
    expect(artifacts.podYaml).toContain('my-app-stack');
  });

  it('creates a placeholder container when bundle metadata lacks containers', () => {
    const artifacts = generateBundleStackArtifacts({ ...baseBundle, containers: [] }, '');
    expect(artifacts.containers).toHaveLength(1);
    expect(artifacts.containers[0].role).toBe('primary');
    expect(artifacts.containers[0].image).toBe('replace/me');
  });

  it('extracts config asset references', () => {
    const artifacts = generateBundleStackArtifacts(baseBundle, baseBundle.displayName);
    expect(artifacts.configPaths).toEqual(['/opt/example/.env']);
  });
});
