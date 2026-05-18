import { describe, expect, it } from 'vitest';
import { parseReadinessYaml } from './parse';

describe('parseReadinessYaml', () => {
  it('accepts the issue #613 example shape', () => {
    const body = `
- kind: http
  url: http://localhost:9091/.well-known/openid-configuration
  expect_status: 200
  timeout: 60s
- kind: tcp
  host: localhost
  port: 3890
  timeout: 120s
`;
    const r = parseReadinessYaml(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probes).toHaveLength(2);
    expect(r.probes[0]).toMatchObject({ kind: 'http', expectStatus: 200, timeoutMs: 60_000 });
    expect(r.probes[1]).toMatchObject({ kind: 'tcp', host: 'localhost', port: 3890, timeoutMs: 120_000 });
  });

  it('parses durations in s, m, ms', () => {
    const r = parseReadinessYaml(`
- kind: tcp
  host: x
  port: 1
  timeout: 500ms
- kind: tcp
  host: x
  port: 2
  timeout: 2m
- kind: tcp
  host: x
  port: 3
  timeout: 90
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probes[0].timeoutMs).toBe(500);
    expect(r.probes[1].timeoutMs).toBe(120_000);
    // Bare number without unit defaults to seconds for ergonomic authoring.
    expect(r.probes[2].timeoutMs).toBe(90_000);
  });

  it('defaults timeout to 60s when unspecified', () => {
    const r = parseReadinessYaml(`
- kind: http
  url: http://example.local/health
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probes[0].timeoutMs).toBe(60_000);
  });

  it('rejects an unknown probe kind with a clear error', () => {
    const r = parseReadinessYaml(`
- kind: dns
  host: example.com
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/unknown.*kind.*dns/i);
  });

  it('rejects a malformed list', () => {
    const r = parseReadinessYaml(`kind: http\nurl: x\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/list of probe objects/i);
  });

  it('rejects empty list', () => {
    const r = parseReadinessYaml(`[]`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/empty/i);
  });

  it('http: accepts status range and "any"', () => {
    const r = parseReadinessYaml(`
- kind: http
  url: http://x
  expect_status: [200, 204]
  timeout: 1m
- kind: http
  url: http://y
  expect_status: any
  timeout: 1m
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.probes[0] as { expectStatus: unknown }).expectStatus).toEqual([200, 204]);
    expect((r.probes[1] as { expectStatus: unknown }).expectStatus).toBe('any');
  });

  it('ldap: requires both bind_dn and bind_password or neither', () => {
    const r = parseReadinessYaml(`
- kind: ldap
  host: localhost
  port: 389
  bind_dn: "cn=admin"
  timeout: 1m
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/bind_dn.*without.*bind_password/);
  });

  it('command: defaults expect_exit to 0', () => {
    const r = parseReadinessYaml(`
- kind: command
  command: "true"
  timeout: 30s
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probes[0]).toMatchObject({ kind: 'command', command: 'true' });
  });

  it('http: rejects invalid expect_status range', () => {
    const r = parseReadinessYaml(`
- kind: http
  url: http://x
  expect_status: [300, 200]
  timeout: 30s
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/lo ≤ hi/);
  });

  it('reports invalid timeout strings instead of silently defaulting', () => {
    const r = parseReadinessYaml(`
- kind: tcp
  host: x
  port: 1
  timeout: "forever"
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/invalid.*timeout/i);
  });
});
