/**
 * `claude_dev_auth` probe — the pure helpers that decide what it reads.
 *
 * The probe's own verdict comes from `claude doctor` on the node, which needs a
 * live agent; these cover the parts that can be got wrong silently on any box
 * and would make the probe read the wrong file or misjudge a token.
 */
import { describe, it, expect } from 'vitest';
import { podHasToken, workspaceHostPath, daysUntil } from './claudeDevAuth';

const pod = (over: Record<string, unknown> = {}) => ({
  spec: {
    containers: [
      {
        env: [{ name: 'CLAUDE_DEV_SSH_PORT', value: '2222' }],
        volumeMounts: [{ name: 'claude-dev-workspace', mountPath: '/workspace' }],
      },
    ],
    volumes: [
      { name: 'claude-dev-workspace', hostPath: { path: '/mnt/data/stacks/claude-dev/workspace' } },
    ],
    ...over,
  },
});

describe('podHasToken', () => {
  it('is false when the variable is absent', () => {
    expect(podHasToken(pod())).toBe(false);
  });

  it('is true for a real token', () => {
    const p = pod();
    p.spec.containers[0].env.push({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat01-xxx' });
    expect(podHasToken(p)).toBe(true);
  });

  it('reads a blank value as NOT set', () => {
    // What a template re-render produces for a `noAutoGenerate` secret, and
    // what clearing the field leaves behind. Treating it as set would warn
    // about a Remote Control problem that no longer exists.
    const p = pod();
    p.spec.containers[0].env.push({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' });
    expect(podHasToken(p)).toBe(false);
    p.spec.containers[0].env.pop();
    p.spec.containers[0].env.push({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '   ' });
    expect(podHasToken(p)).toBe(false);
  });

  it('survives a manifest with no containers or env at all', () => {
    expect(podHasToken({})).toBe(false);
    expect(podHasToken({ spec: {} })).toBe(false);
    expect(podHasToken({ spec: { containers: [{ env: null }] } })).toBe(false);
  });
});

describe('workspaceHostPath', () => {
  it('follows the /workspace mount to its host path', () => {
    // Derived, not hard-coded: a box with a non-default DATA_DIR still has to
    // resolve, and the credentials file is read from whatever comes back.
    expect(workspaceHostPath(pod())).toBe('/mnt/data/stacks/claude-dev/workspace');
  });

  it('returns null when the volume is missing rather than guessing a path', () => {
    const p = pod();
    p.spec.volumes = [];
    expect(workspaceHostPath(p)).toBeNull();
  });

  it('returns null for a relative host path', () => {
    const p = pod();
    p.spec.volumes = [{ name: 'claude-dev-workspace', hostPath: { path: 'relative/path' } }];
    expect(workspaceHostPath(p)).toBeNull();
  });

  it('ignores a mount at some other path', () => {
    const p = pod();
    p.spec.containers[0].volumeMounts = [{ name: 'claude-dev-workspace', mountPath: '/data' }];
    expect(workspaceHostPath(p)).toBeNull();
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

  it('is zero on the final day rather than rounding up to one', () => {
    expect(daysUntil('2026-08-30T23:00:00.000Z', now)).toBe(0);
  });
});
