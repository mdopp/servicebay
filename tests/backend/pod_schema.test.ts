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

// ─── GPU passthrough is single-container-only (#2517) ───────────────────────
// `podman kube play` silently drops resources.limits outside cpu/memory, and
// the `.container` Quadlet escape hatch is one container per unit. The
// daggerheart-chronik shape (chronik + bot sharing hostPath volumes) deployed
// healthy and ran on CPU with no error anywhere — that is what must now fail.
describe('validatePodManifest: GPU in a multi-container pod (#2517)', () => {
    const MULTI_GPU = `
apiVersion: v1
kind: Pod
metadata:
  name: daggerheart-chronik
spec:
  hostNetwork: true
  containers:
  - name: chronik
    image: ghcr.io/example/chronik:latest
    resources:
      limits:
        nvidia.com/gpu: "1"
    volumeMounts:
    - mountPath: /data
      name: data
  - name: bot
    image: ghcr.io/example/bot:latest
    volumeMounts:
    - mountPath: /data
      name: data
  volumes:
  - name: data
    hostPath:
      path: /mnt/data/daggerheart-chronik
      type: DirectoryOrCreate
`;

    const SINGLE_GPU = `
apiVersion: v1
kind: Pod
metadata:
  name: ollama
spec:
  hostNetwork: true
  containers:
  - name: ollama
    image: docker.io/ollama/ollama:latest
    resources:
      limits:
        nvidia.com/gpu: "1"
`;

    it('rejects the two-container pod that requests a GPU', () => {
        const r = validatePodManifest(MULTI_GPU);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('spec.containers[chronik].resources.limits[nvidia.com/gpu]');
    });

    it('names the working alternative, not just the prohibition', () => {
        const msg = validatePodManifest(MULTI_GPU).error?.message ?? '';
        // Actionable: single-container service + `.container` Quadlet + where to read more.
        expect(msg).toMatch(/SINGLE-container/);
        expect(msg).toMatch(/\.container.*Quadlet/);
        expect(msg).toMatch(/AddDevice=nvidia\.com\/gpu=all/);
        expect(msg).toMatch(/hostPath volume/);
        expect(msg).toMatch(/TEMPLATE_AUTHORING\.md/);
    });

    it('accepts a single-container pod that requests a GPU (the ollama shape)', () => {
        expect(validatePodManifest(SINGLE_GPU).ok).toBe(true);
    });

    it('accepts a multi-container pod with no GPU limit', () => {
        const yaml = MULTI_GPU.replace(/    resources:\n      limits:\n        nvidia\.com\/gpu: "1"\n/, '');
        expect(yaml).not.toMatch(/nvidia/);
        expect(validatePodManifest(yaml).ok).toBe(true);
    });

    it('accepts a multi-container pod with plain cpu/memory limits', () => {
        const yaml = MULTI_GPU.replace('        nvidia.com/gpu: "1"', '        cpu: "2"\n        memory: 512Mi');
        expect(validatePodManifest(yaml).ok).toBe(true);
    });

    it('catches a non-NVIDIA vendor GPU key too', () => {
        const yaml = MULTI_GPU.replace('nvidia.com/gpu', 'amd.com/gpu');
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toContain('amd.com/gpu');
    });

    it('counts an initContainer toward the multi-container rule', () => {
        const yaml = `
apiVersion: v1
kind: Pod
metadata:
  name: withinit
spec:
  hostNetwork: true
  initContainers:
  - name: prep
    image: docker.io/library/busybox:latest
  containers:
  - name: app
    image: docker.io/example/app:latest
    resources:
      limits:
        nvidia.com/gpu: "1"
`;
        const r = validatePodManifest(yaml);
        expect(r.ok).toBe(false);
        expect(r.error?.path).toBe('spec.containers[app].resources.limits[nvidia.com/gpu]');
    });
});
