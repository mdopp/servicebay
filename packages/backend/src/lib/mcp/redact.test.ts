import { describe, it, expect } from 'vitest';
import { redactBundleEnvironments, redactKubeYaml, redactLogText, redactQuadletUnit, redactServiceFiles } from './redact';

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

  // ── #581: edge cases the original patterns missed ─────────────────────

  it('redacts backtick-quoted values (template-literal leak from JS services)', () => {
    const input = 'Config loaded: password: `hunter2-template-literal`';
    const out = redactLogText(input);
    expect(out).not.toContain('hunter2-template-literal');
    expect(out).toContain('<redacted>');
  });

  it('redacts backtick values in JSON-style and equals-style forms', () => {
    expect(redactLogText('"token": `tok-here-123`')).not.toContain('tok-here-123');
    expect(redactLogText('apikey=`secret-key-here`')).not.toContain('secret-key-here');
  });

  it('redacts URL query string secrets', () => {
    const input = 'GET https://example.com/api?password=hunter2&format=json HTTP/1.1';
    const out = redactLogText(input);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('<redacted>');
    // Non-sensitive query params left alone.
    expect(out).toContain('format=json');
  });

  it('redacts multiple URL query secrets in the same line', () => {
    const input = 'fetch https://x/y?token=abc&api_key=def&user=alice';
    const out = redactLogText(input);
    expect(out).not.toContain('abc');
    expect(out).not.toContain('def');
    expect(out).toContain('user=alice');
  });

  it('redacts multi-line YAML scalar bodies', () => {
    const input = `
metadata:
  password: |
    line1-of-the-secret
    line2-also-secret
  next-field: kept
`;
    const out = redactLogText(input);
    expect(out).not.toContain('line1-of-the-secret');
    expect(out).not.toContain('line2-also-secret');
    expect(out).toContain('<redacted>');
    expect(out).toContain('next-field: kept');
  });

  it('multi-line YAML redaction stops at the next less-indented key', () => {
    const input = `
secret: |
  very-secret
  more-secret
unrelated_value: visible
`;
    const out = redactLogText(input);
    expect(out).not.toContain('very-secret');
    expect(out).not.toContain('more-secret');
    expect(out).toContain('unrelated_value: visible');
  });

  it('handles YAML block-scalar chomping indicators (|+, |-, >, >-)', () => {
    for (const indicator of ['|', '|+', '|-', '>', '>-']) {
      const input = `token: ${indicator}\n  the-actual-secret-${indicator}\nnext: ok`;
      const out = redactLogText(input);
      expect(out, `indicator=${indicator}`).not.toContain('the-actual-secret');
      expect(out, `indicator=${indicator}`).toContain('next: ok');
    }
  });
});

/**
 * A `.container`-kind Quadlet unit (#2792): the unit file IS the artifact, so
 * `get_service_files` hands this whole body back and there is no pod spec for
 * `redactKubeYaml` to walk. Modelled on the box's own `servicebay.container`.
 */
const CONTAINER_UNIT = [
  '[Unit]',
  'Description=ServiceBay',
  '',
  '[Container]',
  'Image=ghcr.io/mdopp/servicebay:latest',
  'Environment=CONTAINER_HOST=unix:///run/podman/podman.sock',
  'Environment=NODE_ENV=production',
  'Environment=PORT=5888',
  'Environment=SERVICEBAY_USERNAME=admin',
  'Environment=SERVICEBAY_PASSWORD=FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X',
  'Environment=SERVICEBAY_MCP_TOKEN=sb_livetokenvalue123',
  'Environment=OLLAMA_KEEP_ALIVE=24h',
  'Secret=servicebay-oidc,type=env,target=OIDC_CLIENT_SECRET',
  'PodmanArgs=--env ROOM_KEY=room-key-here --label owner=servicebay',
  '',
  '[Install]',
  'WantedBy=default.target',
].join('\n');

describe('redactQuadletUnit (#2792 — .container / systemd unit shape)', () => {
  it('redacts secret-named Environment= values and leaves the rest readable', () => {
    const out = redactQuadletUnit(CONTAINER_UNIT);

    // The leak the issue was filed on.
    expect(out).not.toContain('FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X');
    expect(out).not.toContain('sb_livetokenvalue123');
    expect(out).toContain('Environment=SERVICEBAY_PASSWORD=<redacted>');
    expect(out).toContain('Environment=SERVICEBAY_MCP_TOKEN=<redacted>');

    // Non-secret env vars survive verbatim — a redaction that eats the whole
    // unit is as useless as one that eats nothing.
    expect(out).toContain('Environment=CONTAINER_HOST=unix:///run/podman/podman.sock');
    expect(out).toContain('Environment=NODE_ENV=production');
    expect(out).toContain('Environment=PORT=5888');
    expect(out).toContain('Environment=SERVICEBAY_USERNAME=admin');
    expect(out).toContain('Environment=OLLAMA_KEEP_ALIVE=24h');

    // Structure is untouched.
    expect(out).toContain('[Container]');
    expect(out).toContain('Image=ghcr.io/mdopp/servicebay:latest');
    expect(out).toContain('WantedBy=default.target');
  });

  it('redacts an --env / -e argument passed through PodmanArgs', () => {
    const out = redactQuadletUnit(CONTAINER_UNIT);
    expect(out).not.toContain('room-key-here');
    expect(out).toContain('PodmanArgs=--env ROOM_KEY=<redacted> --label owner=servicebay');

    expect(redactQuadletUnit('Exec=run -e API_TOKEN=abc123 -e TZ=UTC'))
      .toBe('Exec=run -e API_TOKEN=<redacted> -e TZ=UTC');
    expect(redactQuadletUnit('PodmanArgs=--env=DB_PASSWORD=pw --env=DB_PORT=5432'))
      .toBe('PodmanArgs=--env=DB_PASSWORD=<redacted> --env=DB_PORT=5432');
  });

  it('leaves --env-file paths alone (a path, not a value)', () => {
    const line = 'PodmanArgs=--env-file=/mnt/data/stacks/app/secrets.env';
    expect(redactQuadletUnit(line)).toBe(line);
  });

  it('keeps a Secret= reference visible — it names a podman secret, never a literal', () => {
    const out = redactQuadletUnit(CONTAINER_UNIT);
    expect(out).toContain('Secret=servicebay-oidc,type=env,target=OIDC_CLIENT_SECRET');
  });

  it('preserves quoting on multi-assignment Environment= lines', () => {
    expect(redactQuadletUnit('Environment="SB_TOKEN=a b" TZ=Europe/Berlin'))
      .toBe('Environment="SB_TOKEN=<redacted>" TZ=Europe/Berlin');
    expect(redactQuadletUnit('Environment=SHARE_PASSWORD="a b" SHARE_PORT=445'))
      .toBe('Environment=SHARE_PASSWORD="<redacted>" SHARE_PORT=445');
  });

  it('matches the same secret names the kube pass does (ACCOUNT_*, *_KEY, *_SECRET)', () => {
    const out = redactQuadletUnit([
      'Environment=ACCOUNT_samba=supersecretvalue',
      'Environment=VAULTWARDEN_SSO_SECRET=client-secret-here',
      'Environment=SOMETHING_ELSE=kept-as-is',
    ].join('\n'));
    expect(out).not.toContain('supersecretvalue');
    expect(out).not.toContain('client-secret-here');
    expect(out).toContain('kept-as-is');
  });

  it('leaves an empty value alone rather than implying a secret is set', () => {
    expect(redactQuadletUnit('Environment=SHARE_PASSWORD=')).toBe('Environment=SHARE_PASSWORD=');
  });

  it('is a no-op on kube YAML and on empty input', () => {
    const yaml = '    env:\n      - name: SHARE_PASSWORD\n        value: "hunter2"\n';
    expect(redactQuadletUnit(yaml)).toBe(yaml);
    expect(redactQuadletUnit('')).toBe('');
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

  it('redacts a .container service, whose secrets live in kubeContent (#2792)', () => {
    const out = redactServiceFiles({
      quadletKind: 'container',
      kubeContent: CONTAINER_UNIT,
      yamlContent: '',
      serviceContent: 'Environment=SERVICEBAY_PASSWORD=FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X\n',
      kubePath: '/etc/containers/systemd/servicebay.container',
    });
    expect(out.kubeContent).not.toContain('FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X');
    expect(out.kubeContent).not.toContain('sb_livetokenvalue123');
    expect(out.kubeContent).not.toContain('room-key-here');
    expect(out.serviceContent).not.toContain('FGhl06NSRwfWbEQhs8vOfnB5yhxRmD9X');
    expect(out.kubeContent).toContain('Environment=PORT=5888');
    expect(out.kubePath).toBe('/etc/containers/systemd/servicebay.container');
  });

  it('still redacts the .kube/pod-spec shape (no regression on the YAML path)', () => {
    const out = redactServiceFiles({
      kubeContent: '[Kube]\nYaml=file-share.yml\n',
      yamlContent: '      - name: SHARE_PASSWORD\n        value: "hunter2"\n',
      serviceContent: '',
    });
    expect(out.yamlContent).not.toContain('hunter2');
    expect(out.yamlContent).toContain('<redacted>');
    expect(out.kubeContent).toContain('Yaml=file-share.yml');
  });
});

describe('redactBundleEnvironments (#2792)', () => {
  it('masks secret-named values in a bundle serviceTemplate env map', () => {
    const [out] = redactBundleEnvironments([{
      id: 'legacy-stack',
      serviceTemplates: [{
        serviceName: 'nextcloud',
        environment: {
          MYSQL_PASSWORD: 'hunter2',
          NEXTCLOUD_ADMIN_TOKEN: 'tok-here',
          TZ: 'Europe/Berlin',
          PORT: '8080',
        },
      }],
    }]);
    expect(out.serviceTemplates?.[0].environment).toEqual({
      MYSQL_PASSWORD: '<redacted>',
      NEXTCLOUD_ADMIN_TOKEN: '<redacted>',
      TZ: 'Europe/Berlin',
      PORT: '8080',
    });
    expect(out.id).toBe('legacy-stack');
  });

  it('passes bundles without serviceTemplates through untouched', () => {
    const bundle = { id: 'x', displayName: 'X', serviceTemplates: undefined };
    expect(redactBundleEnvironments([bundle])[0]).toBe(bundle);
  });
});
