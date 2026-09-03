/**
 * The migration phase (#2742 cut of #2435/#2503/#2727).
 *
 * `buildMigrationSteps` (the verbatim pass-through) is covered from
 * `runner.test.ts`; what is asserted here is the *phase* around it: which
 * upgrade-preview it asks for, when a chain is selected at all, and — the
 * part that matters most — which failures are best-effort and which ones
 * must stop the deploy with the box untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobInput } from '../jobStore';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
const apiFetchMock = vi.fn<(p: string, init?: RequestInit) => Promise<Response>>();
vi.mock('./context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
  apiFetch: (...args: [string, RequestInit?]) => apiFetchMock(...args),
}));

const migrationScriptsMock = vi.fn();
vi.mock('@/lib/registry', () => ({
  getTemplateMigrationScripts: (name: string, source?: string) => migrationScriptsMock(name, source),
}));

import { runMigrationsPhase } from './migrations';

const yamlAt = (schemaVersion: number, floor?: number) => [
  'apiVersion: v1',
  'kind: Pod',
  'metadata:',
  '  name: media',
  '  annotations:',
  `    servicebay.schema-version: "${schemaVersion}"`,
  ...(floor === undefined ? [] : [`    servicebay.min-upgradable-schema-version: "${floor}"`]),
  'spec:',
  '  containers: []',
].join('\n');

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [],
  variables: [],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

const script = (fromVersion: number, toVersion: number) => ({
  filename: `v${fromVersion}-to-v${toVersion}.py`,
  fromVersion,
  toVersion,
  content: `#!/usr/bin/env python3\n# {{.Image}} stays\n`,
});

const previewOk = (installedVersion: number | null) =>
  new Response(JSON.stringify({ installedVersion }), { status: 200 });

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  apiFetchMock.mockReset();
  migrationScriptsMock.mockReset().mockResolvedValue([]);
});

describe('runMigrationsPhase — chain discovery', () => {
  it('returns the ordered chain, bodies verbatim, for a box that is behind', async () => {
    apiFetchMock.mockResolvedValue(previewOk(1));
    migrationScriptsMock.mockResolvedValue([script(2, 3), script(1, 2)]);

    const steps = await runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) });

    expect(steps?.map(s => s.filename)).toEqual(['v1-to-v2.py', 'v2-to-v3.py']);
    expect(steps?.[0].content).toContain('{{.Image}}');
    expect(migrationScriptsMock).toHaveBeenCalledWith('media', 'Built-in');
  });

  it('asks the upgrade-preview route for this template, with no source param for Built-in', async () => {
    apiFetchMock.mockResolvedValue(previewOk(3));
    await runMigrationsPhase('job1', input(), { name: 'home-assistant', yaml: yamlAt(3) });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/system/templates/home-assistant/upgrade-preview');
  });

  it('carries the external registry through as ?source= so it previews the right template', async () => {
    apiFetchMock.mockResolvedValue(previewOk(3));
    await runMigrationsPhase('job1', input({ templateSource: 'my registry' }), { name: 'media', yaml: yamlAt(3) });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/system/templates/media/upgrade-preview?source=my%20registry');
  });

  it('selects nothing when the box is already at (or above) the template version', async () => {
    apiFetchMock.mockResolvedValue(previewOk(3));
    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) })).resolves.toBeUndefined();
    expect(migrationScriptsMock).not.toHaveBeenCalled();
  });

  it('selects nothing for a fresh install — no recorded version to migrate from', async () => {
    apiFetchMock.mockResolvedValue(previewOk(null));
    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(4) })).resolves.toBeUndefined();
    expect(migrationScriptsMock).not.toHaveBeenCalled();
  });

  it('refuses when the box is behind but the registry ships no hop at all', async () => {
    // The silent-no-op shape this whole area exists to prevent: a v2 box
    // upgrading to a v3 template with zero migration scripts present must
    // stop, not deploy over unmigrated data.
    apiFetchMock.mockResolvedValue(previewOk(2));
    migrationScriptsMock.mockResolvedValue([]);

    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) }))
      .rejects.toThrow(/is incomplete: no script for v2→v3/);
  });
});

describe('runMigrationsPhase — what stops the deploy vs what does not', () => {
  it('re-throws the declared-floor refusal, and logs it, before touching the registry', async () => {
    // #2727 — the floor is checked BEFORE chain selection so the operator is
    // told their recorded version is unsupported, not handed a `missing-step`
    // message about a filename they cannot act on.
    apiFetchMock.mockResolvedValue(previewOk(1));

    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(4, 3) }))
      .rejects.toThrow(/can only be upgraded from v3 or newer/);

    expect(migrationScriptsMock).not.toHaveBeenCalled();
    expect(logMock.mock.calls[0][1]).toMatch(/^❌ Migration chain for media cannot run/);
  });

  it('re-throws an incomplete chain instead of deploying over unmigrated data', async () => {
    apiFetchMock.mockResolvedValue(previewOk(1));
    migrationScriptsMock.mockResolvedValue([script(2, 3)]);

    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) }))
      .rejects.toThrow('Migration chain for media is incomplete: no script for v1→v2 (have v2). Aborting deploy.');
    // A refusal must never be downgraded to the best-effort note below.
    expect(logMock.mock.calls.some(c => c[1].includes('Continuing without migrations'))).toBe(false);
  });

  it('re-throws an overlapping chain — external-registry drift, not a transient', async () => {
    apiFetchMock.mockResolvedValue(previewOk(1));
    migrationScriptsMock.mockResolvedValue([script(1, 2), script(1, 3)]);

    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) }))
      .rejects.toThrow(/overlapping\/invalid steps/);
  });

  it('continues without migrations when the preview call itself fails', async () => {
    // Best-effort by design: if migrations were needed and we skipped them,
    // the new container fails to start and diagnose surfaces it — far better
    // than failing every deploy on a transient loopback error.
    apiFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) })).resolves.toBeUndefined();

    expect(logMock).toHaveBeenCalledWith(
      'job1',
      '⚠️ media: could not check migration chain (ECONNREFUSED). Continuing without migrations.',
    );
  });

  it('continues without migrations when the preview route answers non-2xx', async () => {
    apiFetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(runMigrationsPhase('job1', input(), { name: 'media', yaml: yamlAt(3) })).resolves.toBeUndefined();
    expect(logMock).not.toHaveBeenCalled();
  });
});
