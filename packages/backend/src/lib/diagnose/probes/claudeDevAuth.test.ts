/**
 * `claude_dev_auth` probe.
 *
 * The verdict cases are covered with mocks rather than against a live box on
 * purpose: the reference box had no signed-in state to measure while this was
 * written, so the `ok` path would otherwise ship unverified. The doctor-parsing
 * shape asserted here was captured from the real command's output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import yaml from 'js-yaml';

const { getConfig, getServiceFiles, ensureAgent, sendCommand } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getServiceFiles: vi.fn(),
  ensureAgent: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ getConfig }));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: { getServiceFiles } }));
vi.mock('@/lib/agent/manager', () => ({ agentManager: { ensureAgent } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { checkClaudeDevAuth, podHasToken, workspaceHostPath, daysUntil } = await import(
  './claudeDevAuth'
);

/** A pod manifest shaped like the deployed one. */
function podYaml(opts: { token?: string; volume?: boolean } = {}): string {
  const env = [
    '      - name: CLAUDE_DEV_SSH_PORT',
    '        value: "2222"',
    ...(opts.token === undefined
      ? []
      : ['      - name: CLAUDE_CODE_OAUTH_TOKEN', `        value: "${opts.token}"`]),
  ].join('\n');
  const vol =
    opts.volume === false
      ? '  volumes: []'
      : [
          '  volumes:',
          '  - name: claude-dev-workspace',
          '    hostPath:',
          '      path: /mnt/data/stacks/claude-dev/workspace',
        ].join('\n');
  return [
    'apiVersion: v1',
    'kind: Pod',
    'spec:',
    '  containers:',
    '  - name: claude-dev',
    '    env:',
    env,
    '    volumeMounts:',
    '      - mountPath: /workspace',
    '        name: claude-dev-workspace',
    vol,
  ].join('\n');
}

/** Wire the agent so the credential grep and `claude doctor` answer separately. */
function agent(opts: { expiresAt?: number | null; doctorBlock?: string | null }) {
  sendCommand.mockImplementation(async (_action: string, params?: { command?: string }) => {
    const cmd = params?.command ?? '';
    if (cmd.includes('refreshTokenExpiresAt')) {
      return { stdout: opts.expiresAt ? `"refreshTokenExpiresAt":${opts.expiresAt}` : '' };
    }
    if (cmd.includes('claude doctor')) {
      if (opts.doctorBlock === null) throw new Error('exec failed');
      return { stdout: opts.doctorBlock ?? '' };
    }
    return { stdout: '' };
  });
  ensureAgent.mockResolvedValue({ sendCommand });
}

// One extra hour so the floor in daysUntil() lands on 26 rather than 25 — the
// few milliseconds the test itself takes would otherwise decide it.
const IN_26_DAYS = Date.now() + 26 * 86_400_000 + 3_600_000;
const REACHABLE = 'Remote Control\nControl this session from claude.ai/code or the Claude mobile app\n';
const NOT_SIGNED_IN = [
  'Remote Control',
  'Remote Control requires a claude.ai subscription. Run claude auth login to sign in.',
  '- Not signed in to claude.ai',
  '- claude.ai subscription auth not active',
  '',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({ installedTemplates: { 'claude-dev': { schemaVersion: 2 } } });
  getServiceFiles.mockResolvedValue({ yamlContent: podYaml() });
});

describe('checkClaudeDevAuth — skips', () => {
  it('says nothing when claude-dev is not installed', async () => {
    getConfig.mockResolvedValue({ installedTemplates: {} });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/not installed/i);
  });

  it('skips rather than guessing when the pod definition cannot be read', async () => {
    getServiceFiles.mockRejectedValue(new Error('agent down'));
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('info');
    expect(r.detail).toContain('agent down');
  });

  it('skips when the /workspace volume has no host path', async () => {
    getServiceFiles.mockResolvedValue({ yamlContent: podYaml({ volume: false }) });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('info');
  });

  it('skips when doctor cannot be run, rather than reporting a failure', async () => {
    // An unreachable diagnostic is not evidence that the box is signed out.
    agent({ expiresAt: IN_26_DAYS, doctorBlock: null });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('info');
  });

  it('skips when the credential read throws', async () => {
    ensureAgent.mockRejectedValue(new Error('no agent'));
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('info');
  });
});

describe('checkClaudeDevAuth — token set', () => {
  it('warns that a long-lived token costs Remote Control', async () => {
    getServiceFiles.mockResolvedValue({ yamlContent: podYaml({ token: 'sk-ant-oat01-xxx' }) });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/inference only/i);
    expect(r.detail).toMatch(/mobile app/i);
    expect(r.hint).toMatch(/claude auth login/);
  });

  it('does not warn for a blank token entry', async () => {
    // Clearing the field leaves `value: ""` behind; that is the good state.
    getServiceFiles.mockResolvedValue({ yamlContent: podYaml({ token: '' }) });
    agent({ expiresAt: IN_26_DAYS, doctorBlock: REACHABLE });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('ok');
  });

  it('never puts the token itself in a message', async () => {
    getServiceFiles.mockResolvedValue({ yamlContent: podYaml({ token: 'sk-ant-oat01-SECRET' }) });
    const r = await checkClaudeDevAuth('Local');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('checkClaudeDevAuth — signed in', () => {
  it('reports ok with the expiry date and days remaining', async () => {
    agent({ expiresAt: IN_26_DAYS, doctorBlock: REACHABLE });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/Remote Control is available/);
    expect(r.detail).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(r.detail).toMatch(/26 days/);
  });

  it('is still ok when no stored expiry can be read', async () => {
    // The sign-in state comes from doctor; a missing date only costs context.
    agent({ expiresAt: null, doctorBlock: REACHABLE });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('ok');
  });
});

describe('checkClaudeDevAuth — not signed in', () => {
  it('fails with the reasons doctor gave', async () => {
    agent({ expiresAt: IN_26_DAYS, doctorBlock: NOT_SIGNED_IN });
    const r = await checkClaudeDevAuth('Local');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('Not signed in to claude.ai');
    expect(r.detail).toContain('claude.ai subscription auth not active');
  });

  it('says a future expiry does not mean the sign-in works', async () => {
    // The exact trap this probe exists for: the reference box read 26 days out
    // while every session was unreachable.
    agent({ expiresAt: IN_26_DAYS, doctorBlock: NOT_SIGNED_IN });
    const r = await checkClaudeDevAuth('Local');
    expect(r.detail).toMatch(/does NOT mean the sign-in still works/);
  });

  it('offers the one-tap repair link', async () => {
    agent({ expiresAt: IN_26_DAYS, doctorBlock: NOT_SIGNED_IN });
    const r = await checkClaudeDevAuth('Local');
    expect(r.hint).toContain('/terminal?container=claude-dev-claude-dev&run=claude-login');
  });

  it('reads the credentials from the host path the pod declares', async () => {
    agent({ expiresAt: IN_26_DAYS, doctorBlock: NOT_SIGNED_IN });
    await checkClaudeDevAuth('Local');
    const cmds = sendCommand.mock.calls.map((c) => (c[1] as { command: string }).command);
    const grep = cmds.find((c) => c.includes('refreshTokenExpiresAt'))!;
    expect(grep).toContain('/mnt/data/stacks/claude-dev/workspace/.claude/.credentials.json');
    // Only the match crosses back, never the file.
    expect(grep).toContain('grep -o');
  });
});

describe('podHasToken', () => {
  const doc = (token?: string) =>
    ({
      spec: {
        containers: [
          {
            env:
              token === undefined
                ? [{ name: 'OTHER', value: 'x' }]
                : [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: token }],
          },
        ],
      },
    }) as Parameters<typeof podHasToken>[0];

  it('is false when the variable is absent', () => {
    expect(podHasToken(doc())).toBe(false);
  });

  it('is true for a real token', () => {
    expect(podHasToken(doc('sk-ant-oat01-xxx'))).toBe(true);
  });

  it('reads blank and whitespace-only as NOT set', () => {
    expect(podHasToken(doc(''))).toBe(false);
    expect(podHasToken(doc('   '))).toBe(false);
  });

  it('survives a manifest with no containers or env', () => {
    expect(podHasToken({})).toBe(false);
    expect(podHasToken({ spec: {} })).toBe(false);
    expect(podHasToken({ spec: { containers: [{ env: null }] } })).toBe(false);
  });
});

describe('workspaceHostPath', () => {
  const parsed = (y: string) =>

    yaml.load(y) as Parameters<typeof workspaceHostPath>[0];

  it('follows the /workspace mount to its host path', () => {
    expect(workspaceHostPath(parsed(podYaml()))).toBe('/mnt/data/stacks/claude-dev/workspace');
  });

  it('returns null rather than guessing when the volume is missing', () => {
    expect(workspaceHostPath(parsed(podYaml({ volume: false })))).toBeNull();
  });

  it('returns null for a relative host path', () => {
    const doc = {
      spec: {
        containers: [{ volumeMounts: [{ name: 'w', mountPath: '/workspace' }] }],
        volumes: [{ name: 'w', hostPath: { path: 'relative' } }],
      },
    };
    expect(workspaceHostPath(doc)).toBeNull();
  });
});

describe('daysUntil', () => {
  const now = Date.parse('2026-08-30T00:00:00.000Z');

  it('counts whole days ahead', () => {
    expect(daysUntil('2026-09-25T01:46:00.395Z', now)).toBe(26);
  });

  it('is negative once the date has passed', () => {
    expect(daysUntil('2026-08-20T00:00:00.000Z', now)).toBe(-10);
  });

  it('is zero on the final day rather than rounding up', () => {
    expect(daysUntil('2026-08-30T23:00:00.000Z', now)).toBe(0);
  });
});
