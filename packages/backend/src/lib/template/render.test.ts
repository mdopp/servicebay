/**
 * Render-layer tests (#2206).
 *
 * `renderPodYaml` must never let a variable value's control characters break
 * the pod/quadlet YAML: a multi-line PEM private key substituted verbatim into
 * a double-quoted scalar splits the scalar across lines and podman's Go YAML
 * parser rejects it → crash-loop on the next restart. The escaping must be a
 * faithful round-trip so the container still receives the real value.
 */
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { renderTemplate, renderPodYaml, escapeYamlScalar } from './render';

const PEM =
  '-----BEGIN EC PRIVATE KEY-----\n' +
  'MHcCAQEEIB1a2b3c4d5e6f7g8h9i0jklmnop\n' +
  '-----END EC PRIVATE KEY-----';

const POD = `apiVersion: v1
kind: Pod
metadata:
  name: solaris
spec:
  containers:
  - name: solaris
    env:
    - name: VAPID_PRIVATE_KEY
      value: "{{VAPID_PRIVATE_KEY}}"
    - name: HASS_TOKEN
      value: "{{HASS_TOKEN}}"
`;

describe('renderPodYaml (#2206)', () => {
  it('escapes a multi-line PEM into a single-line \\n scalar that parses', () => {
    const out = renderPodYaml(POD, { VAPID_PRIVATE_KEY: PEM, HASS_TOKEN: 'plain-tok' });
    // Every line still carries a valid `key: value` shape — no bare
    // continuation lines that podman's parser trips on.
    expect(out).toContain('value: "-----BEGIN EC PRIVATE KEY-----\\n');
    // Parseable, and the value round-trips back to the original multi-line PEM.
    const parsed = yaml.load(out) as { spec: { containers: { env: { name: string; value: string }[] }[] } };
    const env = parsed.spec.containers[0].env;
    expect(env.find(e => e.name === 'VAPID_PRIVATE_KEY')?.value).toBe(PEM);
    expect(env.find(e => e.name === 'HASS_TOKEN')?.value).toBe('plain-tok');
  });

  it('the pre-fix raw render produced a scalar with a literal newline', () => {
    // Guard the regression direction: renderTemplate (no escaping) leaves the
    // raw newline in place; renderPodYaml removes it.
    const raw = renderTemplate(POD, { VAPID_PRIVATE_KEY: PEM, HASS_TOKEN: 't' });
    expect(raw).toContain('-----BEGIN EC PRIVATE KEY-----\nMHc');
    const safe = renderPodYaml(POD, { VAPID_PRIVATE_KEY: PEM, HASS_TOKEN: 't' });
    expect(safe).not.toContain('-----BEGIN EC PRIVATE KEY-----\nMHc');
  });

  it('leaves single-line values untouched', () => {
    const out = renderPodYaml(POD, { VAPID_PRIVATE_KEY: 'abc', HASS_TOKEN: 'xyz' });
    expect(out).toContain('value: "abc"');
    expect(out).toContain('value: "xyz"');
  });

  it('escapes a double-quote in a secret so the scalar stays valid (#2224)', () => {
    // A password/secret containing a `"` must not close the double-quoted
    // scalar early — it renders as `\"` and round-trips back verbatim.
    const secret = 'p@ss"w0rd"!';
    const out = renderPodYaml(POD, { VAPID_PRIVATE_KEY: secret, HASS_TOKEN: 'tok' });
    expect(out).toContain('value: "p@ss\\"w0rd\\"!"');
    const parsed = yaml.load(out) as { spec: { containers: { env: { name: string; value: string }[] }[] } };
    const env = parsed.spec.containers[0].env;
    expect(env.find(e => e.name === 'VAPID_PRIVATE_KEY')?.value).toBe(secret);
  });
});

describe('escapeYamlScalar', () => {
  it('escapes backslash before newline so escapes are not doubled', () => {
    expect(escapeYamlScalar('a\\b\nc')).toBe('a\\\\b\\nc');
  });

  it('escapes carriage return and tab', () => {
    expect(escapeYamlScalar('a\r\nb\tc')).toBe('a\\r\\nb\\tc');
  });

  it('round-trips through a YAML parser back to the original value', () => {
    const doc = `value: "${escapeYamlScalar(PEM)}"\n`;
    expect((yaml.load(doc) as { value: string }).value).toBe(PEM);
  });

  it('escapes a double-quote and round-trips (#2224)', () => {
    const val = 'a"b\\c"d';
    expect(escapeYamlScalar(val)).toBe('a\\"b\\\\c\\"d');
    const doc = `value: "${escapeYamlScalar(val)}"\n`;
    expect((yaml.load(doc) as { value: string }).value).toBe(val);
  });
});
