/**
 * #2296 — the deploy path must never persist the redaction mask string
 * `<redacted>` as a real secret value. A consumer that reads a service's
 * variables (secrets come back masked) and re-sends them verbatim caused a
 * multi-service auth outage (HA/Jellyfin/BFF all 401) when the literal
 * `<redacted>` was written into every secret env of the pod.
 *
 * These tests cover the two pure guards, without the heavy runJob mocks:
 *   - `reuseSavedSecrets`: input guard — sentinel-as-value is rejected or
 *     kept from stored; a real value passes through; an omitted/undefined
 *     secret still falls back to stored (existing #615/#2206 behaviour).
 *   - `findSentinelSecretsInYaml`: post-render backstop — fires when a
 *     sentinel slips through into the rendered pod YAML.
 */
import { describe, it, expect } from 'vitest';
import { reuseSavedSecrets, findSentinelSecretsInYaml } from './runner';
import { REDACTION_SENTINEL } from '@/lib/mcp/redact';
import type { JobInputVariable } from './jobStore';

const secret = (name: string, value: string): JobInputVariable => ({
  name,
  value,
  meta: { type: 'secret' },
});

describe('reuseSavedSecrets — <redacted> sentinel input guard (#2296)', () => {
  it('rejects a sentinel value with no stored secret (unresolvable → caller fails loud)', () => {
    const vars = [secret('HASS_TOKEN', REDACTION_SENTINEL)];
    const reused = new Set<string>();
    const r = reuseSavedSecrets(vars, {}, reused, REDACTION_SENTINEL);
    expect(r.sentinelUnresolved).toEqual(['HASS_TOKEN']);
    expect(r.sentinelRestored).toEqual([]);
    // Never mutated to a real value — the caller aborts the deploy.
    expect(vars[0].value).toBe(REDACTION_SENTINEL);
  });

  it('keeps the previously-stored real value when a sentinel is sent', () => {
    const vars = [secret('HASS_TOKEN', REDACTION_SENTINEL)];
    const reused = new Set<string>();
    const r = reuseSavedSecrets(vars, { HASS_TOKEN: 'real-token-123' }, reused, REDACTION_SENTINEL);
    expect(r.sentinelRestored).toEqual(['HASS_TOKEN']);
    expect(r.sentinelUnresolved).toEqual([]);
    // The sentinel is replaced with the real stored secret, never written.
    expect(vars[0].value).toBe('real-token-123');
    expect(reused.has('HASS_TOKEN')).toBe(true);
  });

  it('passes a real supplied secret through unchanged (no stored value)', () => {
    const vars = [secret('SOLARIS_API_KEY', 'freshly-typed')];
    const r = reuseSavedSecrets(vars, {}, new Set(), REDACTION_SENTINEL);
    expect(vars[0].value).toBe('freshly-typed');
    expect(r.sentinelRestored).toEqual([]);
    expect(r.sentinelUnresolved).toEqual([]);
    expect(r.overrideNames).toEqual([]);
  });

  it('reuses a stored secret over a differing real supplied value (existing #615 behaviour)', () => {
    const vars = [secret('LLDAP_ADMIN_PASSWORD', 'wizard-regenerated')];
    const reused = new Set<string>();
    const r = reuseSavedSecrets(vars, { LLDAP_ADMIN_PASSWORD: 'stored-pw' }, reused, REDACTION_SENTINEL);
    expect(vars[0].value).toBe('stored-pw');
    expect(r.overrideNames).toEqual(['LLDAP_ADMIN_PASSWORD']);
    expect(reused.has('LLDAP_ADMIN_PASSWORD')).toBe(true);
  });

  it('leaves non-secret variables alone even if they equal the sentinel', () => {
    const vars: JobInputVariable[] = [
      { name: 'SOME_LABEL', value: REDACTION_SENTINEL, meta: { type: 'text' } },
    ];
    const r = reuseSavedSecrets(vars, {}, new Set(), REDACTION_SENTINEL);
    expect(r.sentinelUnresolved).toEqual([]);
    expect(vars[0].value).toBe(REDACTION_SENTINEL);
  });

  it('handles a mix: sentinel-with-store, sentinel-without-store, real, override', () => {
    const vars = [
      secret('A', REDACTION_SENTINEL),   // stored → restored
      secret('B', REDACTION_SENTINEL),   // no store → unresolved
      secret('C', 'real-c'),             // real, no store → passthrough
      secret('D', 'typed-d'),            // stored differs → override
    ];
    const r = reuseSavedSecrets(vars, { A: 'store-a', D: 'store-d' }, new Set(), REDACTION_SENTINEL);
    expect(r.sentinelRestored).toEqual(['A']);
    expect(r.sentinelUnresolved).toEqual(['B']);
    expect(r.overrideNames).toEqual(['D']);
    expect(vars.map(v => v.value)).toEqual(['store-a', REDACTION_SENTINEL, 'real-c', 'store-d']);
  });
});

describe('findSentinelSecretsInYaml — post-render backstop (#2296)', () => {
  it('fires when a rendered env value equals the sentinel (two-line kube form)', () => {
    const yaml = [
      '    env:',
      '    - name: HASS_TOKEN',
      `      value: "${REDACTION_SENTINEL}"`,
      '    - name: PORT',
      '      value: "8080"',
    ].join('\n');
    expect(findSentinelSecretsInYaml(yaml, REDACTION_SENTINEL)).toEqual(['HASS_TOKEN']);
  });

  it('catches a bare (unquoted) sentinel value', () => {
    const yaml = 'name: JELLYFIN_PASSWORD\nvalue: <redacted>';
    expect(findSentinelSecretsInYaml(yaml, REDACTION_SENTINEL)).toEqual(['JELLYFIN_PASSWORD']);
  });

  it('returns empty for a clean render (real values, no sentinel)', () => {
    const yaml = [
      '    - name: HASS_TOKEN',
      '      value: "real-token"',
      '    - name: JELLYFIN_PASSWORD',
      '      value: "s3cret"',
    ].join('\n');
    expect(findSentinelSecretsInYaml(yaml, REDACTION_SENTINEL)).toEqual([]);
  });

  it('flags every sentinel-valued secret, not just the first', () => {
    const yaml = [
      `- name: A\n  value: "${REDACTION_SENTINEL}"`,
      `- name: B\n  value: "ok"`,
      `- name: C\n  value: "${REDACTION_SENTINEL}"`,
    ].join('\n');
    expect(findSentinelSecretsInYaml(yaml, REDACTION_SENTINEL)).toEqual(['A', 'C']);
  });
});
