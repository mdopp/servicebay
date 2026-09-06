/**
 * #2861 — `AutoUpdate=registry` was written into every generated `.kube`
 * regardless of where the pod's images come from. A `localhost/…` image made
 * `podman auto-update` ping a registry called `localhost`; that ping fails,
 * and the box-wide run exits 125, so twenty other pods lost their update
 * check behind one bad service.
 *
 * The three shapes below are the whole contract: pure-registry must stay
 * byte-identical (no quadlet churn on the box), pure-localhost flips to
 * `local`, and a mixed pod — which one `[Kube]` line cannot express — moves
 * the decision into per-container annotations in the pod YAML.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAutoUpdatePolicy,
  extractPodContainerImages,
  isLocalImage,
} from './quadletAutoUpdate';

/** What every ServiceBay kube-write path generates today. */
const KUBE = '[Kube]\nYaml=svc.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target';

function podYaml(containers: string): string {
  return [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: svc',
    '  labels:',
    '    app: svc',
    '  annotations:',
    '    servicebay.label: "Demo"',
    '    servicebay.schema-version: "3"',
    'spec:',
    '  containers:',
    containers,
    '  volumes: []',
    '',
  ].join('\n');
}

const REGISTRY_ONLY = podYaml([
  '  - name: web',
  '    image: docker.io/library/nginx:1.25',
  '  - name: api',
  '    image: ghcr.io/acme/api:2',
].join('\n'));

const LOCAL_ONLY = podYaml([
  '  - name: gemma',
  '    image: localhost/asteroids-gemma:1',
  '  - name: qwen',
  '    image: localhost/asteroids-qwen:1',
].join('\n'));

const MIXED = podYaml([
  '  - name: gemma',
  '    image: localhost/asteroids-gemma:1',
  '  - name: proxy',
  '    image: docker.io/library/nginx:1.25',
].join('\n'));

describe('isLocalImage', () => {
  it('recognises the localhost/ prefix podman gives a locally built image', () => {
    expect(isLocalImage('localhost/asteroids-gemma:1')).toBe(true);
    expect(isLocalImage('  localhost/x  ')).toBe(true);
  });

  it('does not treat a bare or registry-qualified name as local', () => {
    // Podman resolves an unqualified name through unqualified-search-registries
    // (docker.io), so it auto-updates from a registry like any other image.
    expect(isLocalImage('nginx:1.25')).toBe(false);
    expect(isLocalImage('docker.io/library/nginx:1.25')).toBe(false);
    expect(isLocalImage('ghcr.io/acme/localhost-tools:1')).toBe(false);
  });
});

describe('extractPodContainerImages', () => {
  it('reads name/image pairs out of spec.containers', () => {
    expect(extractPodContainerImages(MIXED)).toEqual([
      { name: 'gemma', image: 'localhost/asteroids-gemma:1' },
      { name: 'proxy', image: 'docker.io/library/nginx:1.25' },
    ]);
  });

  it('ignores initContainers — podman auto-update never acts on them', () => {
    const yaml = [
      'kind: Pod',
      'metadata:',
      '  name: svc',
      'spec:',
      '  initContainers:',
      '  - name: seed',
      '    image: docker.io/library/busybox:1',
      '  containers:',
      '  - name: gemma',
      '    image: localhost/gemma:1',
    ].join('\n');
    expect(extractPodContainerImages(yaml)).toEqual([
      { name: 'gemma', image: 'localhost/gemma:1' },
    ]);
  });

  it('does not mistake a nested env entry for a container', () => {
    const yaml = [
      'kind: Pod',
      'spec:',
      '  containers:',
      '    - name: web',
      '      image: "docker.io/library/nginx:1.25"   # pinned',
      '      env:',
      '        - name: TZ',
      '          value: Europe/Berlin',
      '        - name: PORT',
      '          value: "8080"',
    ].join('\n');
    expect(extractPodContainerImages(yaml)).toEqual([
      { name: 'web', image: 'docker.io/library/nginx:1.25' },
    ]);
  });
});

describe('applyAutoUpdatePolicy — the three image shapes', () => {
  it('leaves an all-registry pod byte-identical (no quadlet churn on the box)', () => {
    const out = applyAutoUpdatePolicy(KUBE, REGISTRY_ONLY);
    expect(out.kubeContent).toBe(KUBE);
    expect(out.podYaml).toBe(REGISTRY_ONLY);
  });

  it('writes AutoUpdate=local when every image is localhost/…', () => {
    const out = applyAutoUpdatePolicy(KUBE, LOCAL_ONLY);
    expect(out.kubeContent).toContain('AutoUpdate=local');
    expect(out.kubeContent).not.toContain('AutoUpdate=registry');
    // Only that one value moved — the rest of the unit is untouched.
    expect(out.kubeContent).toBe(KUBE.replace('AutoUpdate=registry', 'AutoUpdate=local'));
    expect(out.podYaml).toBe(LOCAL_ONLY);
  });

  it('drops the [Kube] line and annotates per container for a mixed pod', () => {
    const out = applyAutoUpdatePolicy(KUBE, MIXED);
    expect(out.kubeContent).not.toMatch(/^\s*AutoUpdate=/m);
    expect(out.kubeContent).toContain('[Kube]\nYaml=svc.yml\n');
    expect(out.podYaml).toContain('io.containers.autoupdate/gemma: "local"');
    expect(out.podYaml).toContain('io.containers.autoupdate/proxy: "registry"');
    // Inserted into the existing metadata.annotations block, at its indent.
    expect(out.podYaml).toMatch(/^ {2}annotations:\n {4}io\.containers\.autoupdate\/gemma: "local"$/m);
    expect(out.podYaml).toContain('servicebay.label: "Demo"');
  });
});

describe('applyAutoUpdatePolicy — what it refuses to touch', () => {
  it('leaves an explicit AutoUpdate=local alone (the hand-repaired box)', () => {
    const hand = KUBE.replace('AutoUpdate=registry', 'AutoUpdate=local');
    expect(applyAutoUpdatePolicy(hand, LOCAL_ONLY).kubeContent).toBe(hand);
  });

  it('leaves a unit with no AutoUpdate= line alone (auto-update toggled off)', () => {
    const off = KUBE.replace('AutoUpdate=registry\n', '');
    const out = applyAutoUpdatePolicy(off, LOCAL_ONLY);
    expect(out.kubeContent).toBe(off);
    expect(out.podYaml).toBe(LOCAL_ONLY);
  });

  it('leaves AutoUpdate=none alone', () => {
    const none = KUBE.replace('AutoUpdate=registry', 'AutoUpdate=none');
    expect(applyAutoUpdatePolicy(none, LOCAL_ONLY).kubeContent).toBe(none);
  });

  it('changes nothing when no container image could be read', () => {
    const out = applyAutoUpdatePolicy(KUBE, 'kind: Pod\nmetadata:\n  name: svc\n');
    expect(out.kubeContent).toBe(KUBE);
  });
});

describe('applyAutoUpdatePolicy — redeploy stability', () => {
  it('is idempotent for the all-local case', () => {
    const once = applyAutoUpdatePolicy(KUBE, LOCAL_ONLY);
    const twice = applyAutoUpdatePolicy(once.kubeContent, once.podYaml);
    expect(twice).toEqual(once);
  });

  it('is idempotent for the mixed case — annotations are never duplicated', () => {
    const once = applyAutoUpdatePolicy(KUBE, MIXED);
    // A redeploy re-renders the pod spec from the template, so the second
    // pass sees the freshly generated unit again, not the annotated one.
    const twice = applyAutoUpdatePolicy(KUBE, once.podYaml);
    expect(twice.podYaml).toBe(once.podYaml);
    expect(
      once.podYaml.match(/io\.containers\.autoupdate\/gemma:/g),
    ).toHaveLength(1);
    expect(
      twice.podYaml.match(/io\.containers\.autoupdate\/gemma:/g),
    ).toHaveLength(1);
  });
});

describe('applyAutoUpdatePolicy — annotation placement corner cases', () => {
  it('creates metadata.annotations when the pod has none', () => {
    const yaml = [
      'apiVersion: v1',
      'kind: Pod',
      'metadata:',
      '  name: svc',
      'spec:',
      '  containers:',
      '  - name: gemma',
      '    image: localhost/gemma:1',
      '  - name: proxy',
      '    image: docker.io/library/nginx:1.25',
      '',
    ].join('\n');
    const out = applyAutoUpdatePolicy(KUBE, yaml);
    expect(out.podYaml).toContain('metadata:\n  annotations:\n    io.containers.autoupdate/gemma: "local"');
    expect(out.kubeContent).not.toMatch(/^\s*AutoUpdate=/m);
  });

  it('annotates the Pod doc of a multi-doc manifest, not the PVC', () => {
    const yaml = [
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      '  name: svc-data',
      '---',
      'apiVersion: v1',
      'kind: Pod',
      'metadata:',
      '  name: svc',
      '  annotations:',
      '    servicebay.label: "Demo"',
      'spec:',
      '  containers:',
      '  - name: gemma',
      '    image: localhost/gemma:1',
      '  - name: proxy',
      '    image: docker.io/library/nginx:1.25',
      '',
    ].join('\n');
    const out = applyAutoUpdatePolicy(KUBE, yaml);
    const [pvc, pod] = out.podYaml.split('---\n');
    expect(pvc).not.toContain('io.containers.autoupdate');
    expect(pod).toContain('io.containers.autoupdate/gemma: "local"');
    expect(pod).toContain('io.containers.autoupdate/proxy: "registry"');
  });

  it('falls back to AutoUpdate=local when the annotations cannot be placed', () => {
    // No `metadata:` to hang them off. `local` never pings a registry, so the
    // box-wide run cannot exit 125 — strictly safer than leaving `registry`.
    const yaml = [
      'kind: Pod',
      'spec:',
      '  containers:',
      '  - name: gemma',
      '    image: localhost/gemma:1',
      '  - name: proxy',
      '    image: docker.io/library/nginx:1.25',
    ].join('\n');
    const out = applyAutoUpdatePolicy(KUBE, yaml);
    expect(out.kubeContent).toContain('AutoUpdate=local');
    expect(out.podYaml).toBe(yaml);
  });
});
