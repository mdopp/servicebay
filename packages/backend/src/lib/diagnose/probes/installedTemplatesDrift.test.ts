/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2902 — the drift probe reports BOTH directions between
 * `config.installedTemplates` and the services that exist, and decides
 * "came from a template" by evidence. The fixtures are the box as
 * measured on 2026-09-08: `radicale` is a record whose service is gone,
 * `ollama` is a record whose service is trashed (restorable), and
 * `servicebay` / `solaris-tts` are live units that never came from a
 * template and must NOT be reported.
 */
const state = {
  config: {} as any,
  quadlets: null as string[] | null,
  trashed: [] as Array<{ service: string }>,
  templates: [] as Array<{ name: string }>,
  dropped: [] as Array<{ name: string; reason: string }>,
  reconcileThrows: null as Error | null,
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));
vi.mock('@/lib/registry', () => ({
  getTemplates: vi.fn(() => Promise.resolve(state.templates)),
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    listQuadletBaseNames: vi.fn(() => Promise.resolve(state.quadlets)),
    listTrashedServices: vi.fn(() => Promise.resolve(state.trashed)),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/install/reconcileInstalledTemplates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/install/reconcileInstalledTemplates')>(
    '@/lib/install/reconcileInstalledTemplates',
  );
  return {
    findInstalledTemplateDrift: actual.findInstalledTemplateDrift,
    reconcileInstalledTemplates: vi.fn(() => {
      if (state.reconcileThrows) return Promise.reject(state.reconcileThrows);
      return Promise.resolve(state.dropped);
    }),
  };
});

import {
  classifyInstalledTemplateDrift,
  checkInstalledTemplatesDrift,
  collectTemplateOriginNames,
} from './installedTemplatesDrift';
import { dispatchProbeAction } from '../actions';
import { reconcileInstalledTemplates } from '@/lib/install/reconcileInstalledTemplates';
import './installedTemplatesDrift';

const reconcileMock = vi.mocked(reconcileInstalledTemplates);

const record = () => ({ schemaVersion: 1, installedAt: '2026-01-01T00:00:00Z' });

beforeEach(() => {
  state.config = {
    installedTemplates: { media: record(), ollama: record(), radicale: record() },
    servicePostDeploy: {},
    installedVariables: [],
  };
  state.quadlets = ['media', 'servicebay', 'solaris-tts'];
  state.trashed = [{ service: 'ollama' }];
  state.templates = [{ name: 'media' }, { name: 'ollama' }, { name: 'radicale' }];
  state.dropped = [];
  state.reconcileThrows = null;
  reconcileMock.mockClear();
});

describe('classifyInstalledTemplateDrift', () => {
  const base = {
    installedNames: ['media', 'ollama', 'radicale'],
    quadletBaseNames: ['media', 'servicebay', 'solaris-tts'],
    trashedServices: ['ollama'],
    templateOriginNames: ['media', 'ollama', 'radicale'],
  };

  it('flags a record whose service exists nowhere', () => {
    expect(classifyInstalledTemplateDrift(base).orphanedRecords).toEqual(['radicale']);
  });

  it('keeps a trashed service out of the drift and names it as retained', () => {
    const r = classifyInstalledTemplateDrift(base);
    expect(r.orphanedRecords).not.toContain('ollama');
    expect(r.awaitingRestore).toEqual(['ollama']);
  });

  it('does not report a live service that has no template origin', () => {
    // `servicebay` is the control plane and `solaris-tts` a sidecar unit the
    // solaris post-deploy wrote: neither resolves as a template, so neither
    // is "installed but unrecorded".
    expect(classifyInstalledTemplateDrift(base).unrecordedServices).toEqual([]);
  });

  it('reports a live service that DOES have template evidence but no record', () => {
    const r = classifyInstalledTemplateDrift({
      ...base,
      quadletBaseNames: [...base.quadletBaseNames, 'vaultwarden'],
      templateOriginNames: [...base.templateOriginNames, 'vaultwarden'],
    });
    expect(r.unrecordedServices).toEqual(['vaultwarden']);
  });

  it('never reports a service that is both recorded and running', () => {
    const r = classifyInstalledTemplateDrift(base);
    expect(r.orphanedRecords).not.toContain('media');
    expect(r.unrecordedServices).not.toContain('media');
  });
});

describe('collectTemplateOriginNames', () => {
  it('takes registry template names AND the config install stamps as evidence', async () => {
    state.templates = [{ name: 'media' }];
    const names = await collectTemplateOriginNames({
      servicePostDeploy: { llama: { lastRunAt: '', exitCode: 0 } },
      installedVariables: [{ varName: 'X', value: '1', service: 'paperless' }],
    } as any);
    expect(names.sort()).toEqual(['llama', 'media', 'paperless']);
  });

  it('contributes nothing when the registry cannot be read, rather than throwing', async () => {
    state.templates = [];
    const { getTemplates } = await import('@/lib/registry');
    vi.mocked(getTemplates).mockRejectedValueOnce(new Error('registry offline'));
    await expect(collectTemplateOriginNames({} as any)).resolves.toEqual([]);
  });
});

describe('checkInstalledTemplatesDrift', () => {
  it('warns and names the orphaned record, with a hint pointing at that direction', async () => {
    const r = await checkInstalledTemplatesDrift('Local');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('radicale');
    expect(r.hint).toMatch(/Records without a service/);
    expect(r.items?.map(i => i.id)).toEqual(['record:radicale']);
  });

  it('names the retained trashed record in the hint so it does not read as a miss', async () => {
    const r = await checkInstalledTemplatesDrift('Local');
    expect(r.hint).toMatch(/Kept on purpose: ollama/);
  });

  it('warns on the other direction with its own hint', async () => {
    state.config.installedTemplates = { media: record() };
    state.quadlets = ['media', 'vaultwarden', 'servicebay'];
    state.trashed = [];
    state.templates = [{ name: 'media' }, { name: 'vaultwarden' }];
    const r = await checkInstalledTemplatesDrift('Local');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('vaultwarden');
    expect(r.hint).toMatch(/Services without a record/);
    expect(r.items?.map(i => i.id)).toEqual(['service:vaultwarden']);
  });

  it('is ok when both directions line up', async () => {
    state.config.installedTemplates = { media: record() };
    state.quadlets = ['media', 'servicebay'];
    state.trashed = [];
    const r = await checkInstalledTemplatesDrift('Local');
    expect(r.status).toBe('ok');
    expect(r.items).toBeUndefined();
  });

  it('is info — never warn — when the node cannot be read', async () => {
    state.quadlets = null;
    const r = await checkInstalledTemplatesDrift('Local');
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/could not read/i);
  });
});

describe('reconcile_installed_templates action', () => {
  it('drops the orphans and names them back to the operator', async () => {
    state.dropped = [{ name: 'radicale', reason: 'no Quadlet unit and no trash entry' }];
    const res = await dispatchProbeAction({
      probeId: 'installed_templates_drift',
      actionId: 'reconcile_installed_templates',
      node: 'Local',
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('radicale');
    expect(reconcileMock).toHaveBeenCalledWith({
      quadletBaseNames: ['media', 'servicebay', 'solaris-tts'],
      trashedServices: ['ollama'],
    });
  });

  it('is idempotent — a second run reports nothing to drop', async () => {
    state.dropped = [];
    const res = await dispatchProbeAction({
      probeId: 'installed_templates_drift',
      actionId: 'reconcile_installed_templates',
      node: 'Local',
    });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Nothing to drop/);
  });

  it('changes nothing when the node cannot be read', async () => {
    state.quadlets = null;
    const res = await dispatchProbeAction({
      probeId: 'installed_templates_drift',
      actionId: 'reconcile_installed_templates',
      node: 'Local',
    });
    expect(res.ok).toBe(false);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
