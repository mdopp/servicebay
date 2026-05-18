import { describe, expect, it } from 'vitest';
import { parseTemplateManifest, readManifestAnnotations } from './contract';

describe('contract: servicebay.readiness block scalar (#613)', () => {
  it('extracts a `|` block scalar with multi-line YAML body', () => {
    const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: example
  annotations:
    servicebay.label: "Example"
    servicebay.readiness: |
      - kind: http
        url: http://localhost:8080/health
        expect_status: 200
        timeout: 60s
spec:
  hostNetwork: true
  containers:
    - name: x
      image: y
`;
    const r = parseTemplateManifest(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.readinessRaw).toContain('- kind: http');
    expect(r.manifest.readinessRaw).toContain('expect_status: 200');
  });

  it('surfaces structural errors at the manifest layer with template-author context', () => {
    const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: example
  annotations:
    servicebay.label: "Example"
    servicebay.readiness: |
      - kind: zone-control
        url: http://x
        timeout: 60s
spec:
  hostNetwork: true
  containers:
    - name: x
      image: y
`;
    const r = parseTemplateManifest(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/servicebay\.readiness/);
    expect(r.errors[0]).toMatch(/zone-control/);
  });

  it('accepts pre-Mustache placeholders inside scalar values', () => {
    const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: example
  annotations:
    servicebay.label: "Example"
    servicebay.readiness: |
      - kind: tcp
        host: localhost
        port: {{LLDAP_LDAP_PORT}}
        timeout: 2m
spec:
  hostNetwork: true
  containers:
    - name: x
      image: y
`;
    const r = parseTemplateManifest(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.readinessRaw).toContain('{{LLDAP_LDAP_PORT}}');
  });

  it('readManifestAnnotations surfaces readinessRaw permissively', () => {
    const yaml = `metadata:
  annotations:
    servicebay.readiness: |
      - kind: http
        url: http://x
        timeout: 30s
`;
    const partial = readManifestAnnotations(yaml);
    expect(partial.readinessRaw).toContain('- kind: http');
  });

  it('templates without readiness annotation parse fine — annotation is optional', () => {
    const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: example
  annotations:
    servicebay.label: "Example"
spec:
  hostNetwork: true
  containers:
    - name: x
      image: y
`;
    const r = parseTemplateManifest(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.readinessRaw).toBeUndefined();
  });
});
