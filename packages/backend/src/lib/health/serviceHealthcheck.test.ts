/**
 * Healthcheck annotation parser tests (#626).
 *
 * Covers the contract `template/contract.ts` and `serviceHealthBootstrap.ts`
 * depend on: defaults, duration parsing, kind discrimination, error
 * surface, and the permissive-vs-strict toggle for Mustache placeholders.
 */
import { describe, it, expect } from 'vitest';
import { parseHealthcheckYaml } from './serviceHealthcheck';

describe('parseHealthcheckYaml — happy paths', () => {
  it('parses the full HTTP example with all fields set', () => {
    const r = parseHealthcheckYaml(`
url: http://localhost:81/api/
interval: 30s
timeout: 5s
startup_timeout: 5m
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual({
      kind: 'http',
      url: 'http://localhost:81/api/',
      host: undefined,
      port: undefined,
      intervalMs: 30_000,
      timeoutMs: 5_000,
      startupTimeoutMs: 300_000,
    });
  });

  it('applies defaults when only `url` is provided', () => {
    const r = parseHealthcheckYaml('url: http://x/health');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.intervalMs).toBe(30_000);
    expect(r.config.timeoutMs).toBe(5_000);
    expect(r.config.startupTimeoutMs).toBe(300_000);
  });

  it('parses TCP probes', () => {
    const r = parseHealthcheckYaml(`
kind: tcp
host: localhost
port: 445
timeout: 2s
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.kind).toBe('tcp');
    expect(r.config.host).toBe('localhost');
    expect(r.config.port).toBe(445);
    expect(r.config.timeoutMs).toBe(2_000);
  });

  it('accepts duration units (ms / s / m) and bare seconds', () => {
    const r = parseHealthcheckYaml(`
url: http://x
interval: 2s
timeout: 500ms
startup_timeout: 10m
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.intervalMs).toBe(2_000);
    expect(r.config.timeoutMs).toBe(500);
    expect(r.config.startupTimeoutMs).toBe(600_000);
  });
});

describe('parseHealthcheckYaml — errors', () => {
  it('rejects missing url on http probes', () => {
    const r = parseHealthcheckYaml('kind: http\ninterval: 30s');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /url.*required/.test(e))).toBe(true);
  });

  it('rejects missing host/port on tcp probes', () => {
    const r = parseHealthcheckYaml('kind: tcp\nhost: localhost');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /port.*required/.test(e))).toBe(true);
  });

  it('rejects unknown kinds', () => {
    const r = parseHealthcheckYaml('kind: udp\nhost: x\nport: 1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /kind.*http.*tcp/.test(e))).toBe(true);
  });

  it('rejects interval shorter than 1s', () => {
    const r = parseHealthcheckYaml('url: http://x\ninterval: 100ms');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /interval.*1s/.test(e))).toBe(true);
  });

  it('rejects malformed YAML', () => {
    const r = parseHealthcheckYaml('url: http://x\n  bad: indent\n: missing-key');
    expect(r.ok).toBe(false);
  });
});

describe('parseHealthcheckYaml — permissive vs strict (Mustache)', () => {
  it('permissive (default): accepts `{{VAR}}` in url and port', () => {
    const r = parseHealthcheckYaml(`
url: http://localhost:{{ADMIN_PORT}}/health
interval: 30s
`);
    expect(r.ok).toBe(true);
  });

  it('permissive (default): accepts `{{VAR}}` for tcp port', () => {
    const r = parseHealthcheckYaml(`
kind: tcp
host: localhost
port: "{{LDAP_PORT}}"
`);
    expect(r.ok).toBe(true);
  });

  it('permissive (default): accepts an unquoted block-scalar `{{VAR}}` tcp port (#1688)', () => {
    // Unquoted, yaml.load mangles `{{VAR}}` into an object — the permissive
    // bypass must still recognise it as a placeholder.
    const r = parseHealthcheckYaml(`
kind: tcp
host: localhost
port: {{GATEKEEPER_PORT}}
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.port).toBeUndefined();
  });

  it('non-permissive: a real numeric tcp port still parses', () => {
    const r = parseHealthcheckYaml(
      'kind: tcp\nhost: localhost\nport: 445',
      { permissive: false },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.port).toBe(445);
  });

  it('permissive (default): accepts an unquoted block-scalar `{{VAR}}` http url (#1688)', () => {
    const r = parseHealthcheckYaml(`
kind: http
url: {{HEALTH_URL}}
`);
    expect(r.ok).toBe(true);
  });

  it('strict: rejects un-resolved `{{VAR}}` placeholders in url', () => {
    const r = parseHealthcheckYaml(
      'url: not-a-url-{{X}}\ninterval: 30s',
      { permissive: false },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/url.*not a valid URL/);
  });

  it('strict: rejects un-resolved port placeholder for tcp', () => {
    const r = parseHealthcheckYaml(
      'kind: tcp\nhost: localhost\nport: "{{P}}"',
      { permissive: false },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /port.*positive integer/.test(e))).toBe(true);
  });
});
