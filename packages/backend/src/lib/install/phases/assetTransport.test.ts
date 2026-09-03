/**
 * Asset transport (#2742) — what one item ships to the box besides the
 * `kube play` itself.
 *
 * The pure guards (`findEmptyYamlVars`, `findSentinelSecretsInYaml`,
 * `authDynamicVars`, `loadPostDeployScript`) have their own tests. This
 * covers the phase that wires them together: which guard warns and which one
 * refuses, what the rendered file set looks like, the env channel scripts
 * read their values from, and the Authelia client preservation that stops an
 * `auth` redeploy from wiping every other stack's SSO.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobInput, JobInputItem } from '../jobStore';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
vi.mock('./context', () => ({ log: (jobId: string, line: string) => logMock(jobId, line) }));

const getConfigMock = vi.fn();
vi.mock('@/lib/config', () => ({ getConfig: () => getConfigMock() }));

vi.mock('@/lib/registry', () => ({ getTemplatePostDeployScript: vi.fn().mockResolvedValue(null) }));

const sendCommandMock = vi.fn();
const ensureAgentMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (node: string) => ensureAgentMock(node) },
}));

const mergeClientsMock = vi.fn<(rendered: string, existing: string) => string>();
vi.mock('@/lib/capabilities/autheliaClientMerge', () => ({
  mergeAutheliaOidcClients: (rendered: string, existing: string) => mergeClientsMock(rendered, existing),
}));

import { buildPostDeployEnv, preserveAutheliaOidcClients, runAssetTransportPhase } from './assetTransport';

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [],
  variables: [],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

const item = (over: Partial<JobInputItem> & { yaml: string }): JobInputItem & { yaml: string } => ({
  name: 'media',
  checked: true,
  ...over,
});

const lines = () => logMock.mock.calls.map(c => c[1]);

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  getConfigMock.mockReset().mockResolvedValue({});
  sendCommandMock.mockReset();
  ensureAgentMock.mockReset().mockResolvedValue({ sendCommand: sendCommandMock });
  mergeClientsMock.mockReset().mockImplementation(rendered => rendered);
});

describe('runAssetTransportPhase — the rendered pod + file set', () => {
  it('renders the pod against the wizard variables and emits the Quadlet unit', async () => {
    const assets = await runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'JELLYFIN_IMAGE', value: 'lscr.io/jellyfin:10.9' }] }),
      item({ yaml: 'spec:\n  containers:\n    - image: {{JELLYFIN_IMAGE}}\n' }),
    );

    expect(assets.yamlContent).toContain('image: lscr.io/jellyfin:10.9');
    expect(assets.kubeContent).toBe(
      '[Kube]\nYaml=media.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target',
    );
  });

  it('injects the auth stack’s LLDAP re-key flag into the render view (#666)', async () => {
    const assets = await runAssetTransportPhase(
      'job1',
      input(),
      item({ name: 'auth', yaml: 'env:\n  - name: RESET\n    value: "{{LLDAP_FORCE_LDAP_USER_PASS_RESET}}"\n' }),
    );
    expect(assets.yamlContent).toContain('value: "always"');
  });

  it('escapes a multi-line secret so the pod YAML still parses (#2206)', async () => {
    const assets = await runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'RSA_KEY', value: '-----BEGIN-----\nline2' }] }),
      item({ yaml: 'env:\n  - name: KEY\n    value: "{{RSA_KEY}}"\n' }),
    );
    expect(assets.yamlContent).toContain('value: "-----BEGIN-----\\nline2"');
    expect(assets.yamlContent.split('\n')).toHaveLength(4);
  });

  it('warns — but still deploys — when a direct pod variable renders empty (#1318)', async () => {
    const assets = await runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'FILLED', value: 'x' }, { name: 'BLANK', value: '' }] }),
      item({ yaml: 'a: {{FILLED}}\nb: {{BLANK}}\nc: {{NEVER_DECLARED}}\n' }),
    );

    expect(lines()[0]).toContain('media: pod template variable(s) rendered empty: BLANK, NEVER_DECLARED');
    expect(assets.yamlContent).toContain('a: x');
  });

  it('refuses to deploy a pod whose env rendered to the redaction mask (#2296)', async () => {
    // Deploying this would push `<redacted>` onto the box as a live secret
    // and take the service's auth offline.
    await expect(runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'IMMICH_DB_PASSWORD', value: '<redacted>' }] }),
      item({ name: 'immich', yaml: 'env:\n  - name: DB_PASSWORD\n    value: "{{IMMICH_DB_PASSWORD}}"\n' }),
    )).rejects.toThrow(/env var\(s\) rendered to the redaction mask '<redacted>' instead of a real secret: DB_PASSWORD/);

    expect(lines().at(-1)).toMatch(/^❌ Cannot deploy immich/);
  });

  it('renders each config file’s target path and body, and drops the ones with no target', async () => {
    const assets = await runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'DATA_DIR', value: '/mnt/data/stacks' }, { name: 'PORT', value: '8096' }] }),
      item({
        yaml: 'spec: {}\n',
        configFiles: [
          { filename: 'app.conf', content: 'port={{PORT}}', targetPath: '{{DATA_DIR}}/media/app.conf' },
          { filename: 'README.md', content: 'no target' },
        ],
      }),
    );

    expect(assets.extraFiles).toEqual([
      { path: '/mnt/data/stacks/media/app.conf', content: 'port=8096' },
    ]);
  });

  it('ships an asset file verbatim — {{…}} in a SKILL.md body is documentation, not a ref (#1156)', async () => {
    const assets = await runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'DATA_DIR', value: '/mnt/data/stacks' }] }),
      item({
        yaml: 'spec: {}\n',
        configFiles: [{
          filename: 'SKILL.md',
          content: 'call it with {{UNDECLARED_PLACEHOLDER}}',
          targetPath: '{{DATA_DIR}}/media/SKILL.md',
          renderContent: false,
        }],
      }),
    );

    expect(assets.extraFiles[0].content).toBe('call it with {{UNDECLARED_PLACEHOLDER}}');
  });

  it('refuses when a rendered config file references a variable with no value', async () => {
    await expect(runAssetTransportPhase(
      'job1',
      input({ variables: [{ name: 'DATA_DIR', value: '/mnt/data/stacks' }] }),
      item({
        yaml: 'spec: {}\n',
        configFiles: [{ filename: 'app.conf', content: 'key={{MISSING_KEY}}', targetPath: '{{DATA_DIR}}/x.conf' }],
      }),
    )).rejects.toThrow('Cannot deploy media: app.conf references variable(s) with no value: MISSING_KEY. Go back to the Configure step and fill them in (or check the template\'s variables.json defaults).');
  });
});

describe('buildPostDeployEnv — the only channel a script gets values through (#2415)', () => {
  it('carries every wizard variable plus HOST, LAN_IP and OPERATOR_EMAIL', async () => {
    getConfigMock.mockResolvedValue({
      reverseProxy: { lanIp: '192.168.1.50' },
      notifications: { email: { to: ['  ops@example.com  '] } },
    });

    const env = await buildPostDeployEnv(input({
      host: 'servicebay.lan',
      variables: [{ name: 'IMMICH_ADMIN_EMAIL', value: 'a@b.c' }],
    }));

    expect(env).toEqual({
      IMMICH_ADMIN_EMAIL: 'a@b.c',
      HOST: 'servicebay.lan',
      LAN_IP: '192.168.1.50',
      OPERATOR_EMAIL: 'ops@example.com',
    });
  });

  it('falls back to localhost and leaves the optional vars unset', async () => {
    getConfigMock.mockResolvedValue({});
    expect(await buildPostDeployEnv(input({ host: '' }))).toEqual({ HOST: 'localhost' });
  });

  it('still returns the wizard values when the config cannot be read', async () => {
    getConfigMock.mockRejectedValue(new Error('config unreadable'));
    const env = await buildPostDeployEnv(input({ variables: [{ name: 'X', value: '1' }] }));
    expect(env).toEqual({ X: '1', HOST: 'servicebay.local' });
  });
});

describe('preserveAutheliaOidcClients (#1724)', () => {
  const configPath = '/mnt/data/stacks/auth/authelia-config/configuration.yml';

  it('does not touch the box for a stack that ships no Authelia config', async () => {
    const files = [{ path: '/mnt/data/stacks/immich/immich.env', content: 'X=1' }];
    await expect(preserveAutheliaOidcClients('job1', 'Local', files)).resolves.toBeNull();
    expect(ensureAgentMock).not.toHaveBeenCalled();
  });

  it('merges the on-disk clients into the fresh render and says so', async () => {
    sendCommandMock.mockResolvedValue({ content: 'clients: [media]' });
    mergeClientsMock.mockReturnValue('clients: [servicebay, media]');
    const files = [{ path: configPath, content: 'clients: [servicebay]' }];

    const existing = await preserveAutheliaOidcClients('job1', 'Local', files);

    expect(sendCommandMock).toHaveBeenCalledWith('read_file', { path: configPath });
    expect(mergeClientsMock).toHaveBeenCalledWith('clients: [servicebay]', 'clients: [media]');
    // The merge is written back into the file that is about to be deployed.
    expect(files[0].content).toBe('clients: [servicebay, media]');
    expect(existing).toBe('clients: [media]');
    expect(lines()[0]).toContain('Preserved existing Authelia OIDC client registrations');
  });

  it('stays quiet when the fresh render already owns every client on disk', async () => {
    sendCommandMock.mockResolvedValue({ stdout: 'clients: [servicebay]' });
    const files = [{ path: configPath, content: 'clients: [servicebay]' }];

    await expect(preserveAutheliaOidcClients('job1', undefined, files)).resolves.toBe('clients: [servicebay]');

    expect(ensureAgentMock).toHaveBeenCalledWith('Local');
    expect(logMock).not.toHaveBeenCalled();
  });

  it('treats an empty read as a fresh install — nothing to preserve', async () => {
    sendCommandMock.mockResolvedValue({ content: '' });
    const files = [{ path: configPath, content: 'clients: [servicebay]' }];
    await expect(preserveAutheliaOidcClients('job1', 'Local', files)).resolves.toBeNull();
    expect(mergeClientsMock).not.toHaveBeenCalled();
  });

  it('warns and leaves the fresh render untouched when the box is unreachable', async () => {
    ensureAgentMock.mockRejectedValue(new Error('agent offline'));
    const files = [{ path: configPath, content: 'clients: [servicebay]' }];

    await expect(preserveAutheliaOidcClients('job1', 'Local', files)).resolves.toBeNull();

    expect(files[0].content).toBe('clients: [servicebay]');
    expect(lines()[0]).toContain('Could not preserve existing Authelia OIDC clients (agent offline)');
  });
});
