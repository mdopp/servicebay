import { describe, it, expect } from 'vitest';
import { validatePodManifest } from '@/lib/services/podSchema';

const VALID = `
apiVersion: v1
kind: Pod
metadata:
  name: example
spec:
  hostNetwork: true
  containers:
  - name: app
    image: docker.io/library/nginx:latest
    ports:
    - containerPort: 80
    volumeMounts:
    - mountPath: /data
      name: data
  volumes:
  - name: data
    hostPath:
      path: /mnt/data/example
      type: DirectoryOrCreate
`;

describe('validatePodManifest', () => {
    it('accepts a well-formed Pod', () => {
        const r = validatePodManifest(VALID);
        expect(r.ok).toBe(true);
    });

    it('rejects empty input', () => {
        const r = validatePodManifest('');
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('$');
    });

    it('rejects YAML that does not parse', () => {
        const r = validatePodManifest('this: is: broken: yaml');
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('$');
    });

    it('rejects when no Pod doc is present', () => {
        const r = validatePodManifest(`apiVersion: v1\nkind: Service\nmetadata:\n  name: foo\n`);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('kind');
    });

    it('rejects wrong apiVersion', () => {
        const yaml = VALID.replace('apiVersion: v1', 'apiVersion: v2alpha1');
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('apiVersion');
    });

    it('rejects metadata.name that is not a DNS-1123 label', () => {
        const yaml = VALID.replace('name: example', 'name: Example_Pod');
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('metadata.name');
    });

    it('rejects empty containers array', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: empty
spec:
  hostNetwork: true
  containers: []
`;
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('spec.containers');
    });

    it('rejects a container with no image', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: noimg
spec:
  hostNetwork: true
  containers:
  - name: app
`;
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toContain('containers');
    });

    it('rejects a volumeMount that points at an undeclared volume', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: typo
spec:
  hostNetwork: true
  containers:
  - name: app
    image: x
    volumeMounts:
    - mountPath: /data
      name: typo-data
  volumes:
  - name: actual-data
    hostPath:
      path: /mnt/data
`;
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(/typo-data/);
        expect(r.error?.message).toMatch(/not declared/);
    });

    it('rejects a port without hostPort outside hostNetwork', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: unreachable
spec:
  containers:
  - name: app
    image: x
    ports:
    - containerPort: 8080
`;
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(/unreachable/);
    });

    it('accepts a port without hostPort when hostNetwork: true', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ok
spec:
  hostNetwork: true
  containers:
  - name: app
    image: x
    ports:
    - containerPort: 8080
`;
        expect(validatePodManifest(yaml).ok).toBe(true);
    });

    it('accepts a Pod + PVC multi-doc bundle (file-share shape)', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: file-share
spec:
  hostNetwork: true
  containers:
  - name: syncthing
    image: docker.io/syncthing/syncthing:latest
    ports:
    - containerPort: 8384
    volumeMounts:
    - mountPath: /var/syncthing/config
      name: syncthing-config
  volumes:
  - name: syncthing-config
    persistentVolumeClaim:
      claimName: file-share-syncthing-config
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: file-share-syncthing-config
`;
        expect(validatePodManifest(yaml).ok).toBe(true);
    });

    it('rejects a malformed PVC alongside a valid Pod', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ok
spec:
  hostNetwork: true
  containers:
  - name: app
    image: x
---
apiVersion: v2
kind: PersistentVolumeClaim
metadata:
  name: bad
`;
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toMatch(/PVC/);
    });
});
