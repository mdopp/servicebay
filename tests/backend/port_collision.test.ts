// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ServiceManager } from '../../src/lib/services/ServiceManager';

describe('extractHostPorts', () => {
  it('returns numeric host ports from a kube YAML', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: filebrowser
spec:
  containers:
    - name: filebrowser
      image: filebrowser/filebrowser
      ports:
        - containerPort: 8088
          hostPort: 8088
        - containerPort: 9999
          hostPort: 9999
`;
    expect(ServiceManager.extractHostPorts(yaml).sort()).toEqual([8088, 9999]);
  });

  it('handles multiple containers in one pod', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata: { name: stack }
spec:
  containers:
    - name: a
      image: a:latest
      ports:
        - { containerPort: 80, hostPort: 8080 }
    - name: b
      image: b:latest
      ports:
        - { containerPort: 90, hostPort: 8090 }
`;
    expect(ServiceManager.extractHostPorts(yaml).sort()).toEqual([8080, 8090]);
  });

  it('coerces string hostPort values', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: x
      image: x:latest
      ports:
        - containerPort: 80
          hostPort: "8080"
`;
    expect(ServiceManager.extractHostPorts(yaml)).toEqual([8080]);
  });

  it('skips containerPort-only entries (no hostPort)', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: x
      image: x:latest
      ports:
        - containerPort: 80
`;
    expect(ServiceManager.extractHostPorts(yaml)).toEqual([]);
  });

  it('returns deduplicated ports', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: x
      image: x:latest
      ports:
        - { containerPort: 80, hostPort: 8080 }
        - { containerPort: 81, hostPort: 8080 }
`;
    expect(ServiceManager.extractHostPorts(yaml)).toEqual([8080]);
  });

  it('falls back to regex on malformed YAML', () => {
    // tab + space mixed indentation that yaml.loadAll rejects
    const yaml = "spec:\n\tcontainers:\n  - hostPort: 7777";
    expect(ServiceManager.extractHostPorts(yaml)).toContain(7777);
  });

  it('returns empty for YAML with no ports section', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: x
      image: x:latest
`;
    expect(ServiceManager.extractHostPorts(yaml)).toEqual([]);
  });
});
