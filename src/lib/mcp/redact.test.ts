import { describe, it, expect } from 'vitest';
import { redactKubeYaml, redactLogText, redactServiceFiles } from './redact';

describe('redactKubeYaml', () => {
  it('redacts the value of a *_PASSWORD env entry (two-line YAML)', () => {
    const input = `
    env:
      - name: SHARE_PASSWORD
        value: "FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X"
      - name: SOME_PORT
        value: "8088"
`;
    const out = redactKubeYaml(input);
    expect(out).toContain('SHARE_PASSWORD');
    expect(out).not.toContain('FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X');
    expect(out).toContain('<redacted>');
    // Non-sensitive value left alone.
    expect(out).toContain('"8088"');
  });

  it('redacts ACCOUNT_* env entries (samba convention)', () => {
    const input = `
      - name: ACCOUNT_samba
        value: "supersecretvalue"
`;
    const out = redactKubeYaml(input);
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('<redacted>');
  });

  it('redacts *_SECRET, *_TOKEN, *_KEY env entries', () => {
    const input = `
      - name: VAULTWARDEN_SSO_SECRET
        value: "client-secret-here"
      - name: AGENT_AUTH_TOKEN
        value: "tok-here"
      - name: ROOM_KEY
        value: "key-here"
      - name: SOMETHING_ELSE
        value: "kept-as-is"
`;
    const out = redactKubeYaml(input);
    expect(out).not.toContain('client-secret-here');
    expect(out).not.toContain('tok-here');
    expect(out).not.toContain('key-here');
    expect(out).toContain('kept-as-is');
  });

  it('handles unquoted values', () => {
    const input = `      - name: API_TOKEN\n        value: rawvalue\n`;
    const out = redactKubeYaml(input);
    expect(out).not.toContain('rawvalue');
    expect(out).toContain('<redacted>');
  });

  it('redacts JSON-form name/value pairs', () => {
    const input = `{"env":[{"name":"DB_PASSWORD","value":"hunter2"},{"name":"DB_PORT","value":"5432"}]}`;
    const out = redactKubeYaml(input);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('5432');
  });

  it('returns empty input unchanged', () => {
    expect(redactKubeYaml('')).toBe('');
  });
});

describe('redactLogText', () => {
  it('redacts `password: X` log lines', () => {
    expect(redactLogText('Connecting with password: hunter2'))
      .toBe('Connecting with password: <redacted>');
  });

  it('redacts `password=X`', () => {
    expect(redactLogText('admin password=hunter2'))
      .toBe('admin password=<redacted>');
  });

  it('redacts JSON-style `"password":"X"`', () => {
    const out = redactLogText('{"username":"admin","password":"hunter2"}');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('<redacted>');
    expect(out).toContain('"username":"admin"');
  });

  it('redacts `--password X` CLI args', () => {
    expect(redactLogText('podman exec foo --password hunter2 add user'))
      .toBe('podman exec foo --password <redacted> add user');
  });

  it('redacts `Bearer <token>`', () => {
    const out = redactLogText('Authorization: Bearer sb_abc123_XYZ');
    expect(out).toBe('Authorization: Bearer <redacted>');
  });

  it('redacts secret/token/api-key variants', () => {
    expect(redactLogText('secret: abc123')).toContain('<redacted>');
    expect(redactLogText('token=abc123')).toContain('<redacted>');
    expect(redactLogText('api_key=abc123')).toContain('<redacted>');
    expect(redactLogText('apikey: abc123')).toContain('<redacted>');
  });

  it('leaves unrelated text untouched', () => {
    const input = 'Listening on 127.0.0.1:8088';
    expect(redactLogText(input)).toBe(input);
  });

  it('returns empty input unchanged', () => {
    expect(redactLogText('')).toBe('');
  });
});

describe('redactServiceFiles', () => {
  it('redacts yamlContent + serviceContent + kubeContent, preserves paths', () => {
    const input = {
      kubeContent: '[Kube]\nYaml=file-share.yml\n',
      yamlContent: '      - name: SHARE_PASSWORD\n        value: "hunter2"\n',
      serviceContent: 'Environment=PODMAN_SYSTEMD_UNIT=%n',
      yamlPath: '.config/containers/systemd/file-share.yml',
      kubePath: '.config/containers/systemd/file-share.kube',
      servicePath: '/run/user/1000/systemd/generator/file-share.service',
    };
    const out = redactServiceFiles(input);
    expect(out.yamlContent).not.toContain('hunter2');
    expect(out.yamlContent).toContain('<redacted>');
    expect(out.yamlPath).toBe(input.yamlPath);
    expect(out.kubePath).toBe(input.kubePath);
    expect(out.servicePath).toBe(input.servicePath);
  });
});
