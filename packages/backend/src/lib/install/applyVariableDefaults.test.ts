import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1297 — applyVariableDefaults merges variables.json defaults into a (possibly
// replayed) JobInput. Mock only the template-metadata source; the merge logic
// is the real code path.
const { mockReg } = vi.hoisted(() => ({ mockReg: { getTemplateVariables: vi.fn() } }));
vi.mock('@/lib/registry', async (orig) => ({
  ...(await orig<typeof import('@/lib/registry')>()),
  getTemplateVariables: mockReg.getTemplateVariables,
}));

// #2439 — the LLDAP_BASE_DN safety net reads the box's public domain.
const { mockCfg } = vi.hoisted(() => ({ mockCfg: { getConfig: vi.fn() } }));
vi.mock('@/lib/config', async (orig) => ({
  ...(await orig<typeof import('@/lib/config')>()),
  getConfig: mockCfg.getConfig,
}));

import { applyVariableDefaults } from './manifestAssembler';
import type { JobInput } from './jobStore';

function input(partial: Partial<JobInput>): JobInput {
  const base: JobInput = { items: [], variables: [], wipeMode: 'install', templateSource: 'installed', host: 'localhost' };
  return { ...base, ...partial };
}

beforeEach(() => {
  vi.clearAllMocks();
  // #2531 — the saved operator-set variables are read from config on every
  // call, so every test needs a config. Individual tests override.
  mockCfg.getConfig.mockResolvedValue({});
});

describe('applyVariableDefaults (#1297)', () => {
  it('fills a newly-added variable default that is missing from a replayed manifest', async () => {
    // OSCAR repro: an older saved manifest has SERVICEBAY_MCP_URL but not the
    // later-added GATEKEEPER_MCP_URL.
    mockReg.getTemplateVariables.mockResolvedValue({
      SERVICEBAY_MCP_URL: { default: 'http://127.0.0.1:5888/mcp' },
      GATEKEEPER_MCP_URL: { default: 'http://127.0.0.1:10760/mcp' },
    });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'oscar-household', checked: true }],
      variables: [{ name: 'SERVICEBAY_MCP_URL', value: 'http://custom' }],
    }));
    expect(out.variables.find(v => v.name === 'GATEKEEPER_MCP_URL')?.value).toBe('http://127.0.0.1:10760/mcp');
  });

  it('never overrides a non-empty manifest value (manifest wins)', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ SERVICEBAY_MCP_URL: { default: 'http://default' } });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [{ name: 'SERVICEBAY_MCP_URL', value: 'http://custom' }],
    }));
    expect(out.variables.find(v => v.name === 'SERVICEBAY_MCP_URL')?.value).toBe('http://custom');
  });

  it('fills an empty existing slot from the default', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ FOO: { default: 'bar' } });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [{ name: 'FOO', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'FOO')?.value).toBe('bar');
  });

  it('ignores variables that have no default', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ NO_DEFAULT: { type: 'text' }, HAS: { default: 'd' } });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [],
    }));
    expect(out.variables.find(v => v.name === 'NO_DEFAULT')).toBeUndefined();
    expect(out.variables.find(v => v.name === 'HAS')?.value).toBe('d');
  });

  it('skips unchecked / already-installed items and returns the input unchanged when nothing fills', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ FOO: { default: 'bar' } });
    const original = input({
      items: [{ name: 'x', checked: true, alreadyInstalled: true }, { name: 'y', checked: false }],
      variables: [{ name: 'FOO', value: 'set' }],
    });
    const out = await applyVariableDefaults(original);
    expect(mockReg.getTemplateVariables).not.toHaveBeenCalled();
    expect(out).toBe(original); // same reference — no allocation when nothing changed
  });

  // #2439 — LLDAP_BASE_DN is derived, not defaulted, so a manifest replayed
  // from before the variable existed would otherwise deploy a blank base DN.
  it('derives an empty LLDAP_BASE_DN from the box public domain', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
    mockCfg.getConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'example.com' } });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'auth', checked: true }],
      variables: [{ name: 'LLDAP_BASE_DN', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value).toBe('dc=example,dc=com');
  });

  it('leaves an installed LLDAP_BASE_DN alone — never re-roots a live tree', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
    mockCfg.getConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'example.com' } });
    const original = input({
      items: [{ name: 'auth', checked: true }],
      variables: [{ name: 'LLDAP_BASE_DN', value: 'dc=legacy,dc=tree' }],
    });
    const out = await applyVariableDefaults(original);
    expect(out).toBe(original);
  });

  it('does not invent an LLDAP_BASE_DN for a stack that has none', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ FOO: { default: 'bar' } });
    mockCfg.getConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'example.com' } });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [{ name: 'FOO', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'LLDAP_BASE_DN')).toBeUndefined();
  });

  it('does not mutate the caller\'s input', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ NEW: { default: 'v' } });
    const original = input({ items: [{ name: 'x', checked: true }], variables: [] });
    const out = await applyVariableDefaults(original);
    expect(original.variables).toHaveLength(0); // untouched
    expect(out.variables).toHaveLength(1);
  });
});

/**
 * #2531 — this is the END-TO-END point for the reported failure: the reinstall
 * path replays a saved JobInput and never calls `assembleManifest`, but every
 * install (MCP `install_template` and `POST /api/install/start`) goes through
 * `applyVariableDefaults`. The operator's value has to be restored here.
 */
describe('applyVariableDefaults — operator-set values survive a reinstall (#2531)', () => {
  const solaris = {
    VAPID_PUBLIC_KEY: { type: 'text', default: '' },
    VAPID_SUBJECT: { type: 'text', default: '' },
    VAPID_PRIVATE_KEY: { type: 'secret' },
  };

  it('restores an operator-set text variable whose variables.json default is empty', async () => {
    mockReg.getTemplateVariables.mockResolvedValue(solaris);
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [{ varName: 'VAPID_PUBLIC_KEY', value: 'BKxOperatorSetKey' }],
    });
    // The reported repro: plain reinstall, no overrides, the replayed manifest
    // carries the variable with the blank the previous run left behind.
    const out = await applyVariableDefaults(input({
      items: [{ name: 'solaris', checked: true }],
      variables: [{ name: 'VAPID_PUBLIC_KEY', value: '' }, { name: 'VAPID_SUBJECT', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'VAPID_PUBLIC_KEY')?.value).toBe('BKxOperatorSetKey');
    // A variable that was blank BY DESIGN stays blank — nothing is invented.
    expect(out.variables.find(v => v.name === 'VAPID_SUBJECT')?.value).toBe('');
  });

  it('adds the variable back when the replayed manifest predates it', async () => {
    mockReg.getTemplateVariables.mockResolvedValue(solaris);
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [{ varName: 'VAPID_PUBLIC_KEY', value: 'BKx' }],
    });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'solaris', checked: true }],
      variables: [],
    }));
    expect(out.variables.find(v => v.name === 'VAPID_PUBLIC_KEY')?.value).toBe('BKx');
  });

  it('ranks the operator value above the template default', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ PORT: { type: 'text', default: '8080' } });
    mockCfg.getConfig.mockResolvedValue({ installedVariables: [{ varName: 'PORT', value: '9000' }] });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [{ name: 'PORT', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'PORT')?.value).toBe('9000');
  });

  it('still lets an explicit manifest value win over the saved one', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ PORT: { type: 'text', default: '8080' } });
    mockCfg.getConfig.mockResolvedValue({ installedVariables: [{ varName: 'PORT', value: '9000' }] });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [{ name: 'PORT', value: '7000' }],
    }));
    expect(out.variables.find(v => v.name === 'PORT')?.value).toBe('7000');
  });

  it('does not invent a variable the selected templates do not declare', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ FOO: { default: 'bar' } });
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [{ varName: 'SOME_OTHER_TEMPLATES_VAR', value: 'v' }],
    });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'x', checked: true }],
      variables: [],
    }));
    expect(out.variables.find(v => v.name === 'SOME_OTHER_TEMPLATES_VAR')).toBeUndefined();
  });
});

/**
 * #2785 — an UNATTENDED redeploy must keep the per-service values the last
 * install actually deployed, instead of silently re-deriving them from the
 * template. The values in question arrive through `install_template({variables})`,
 * i.e. `prefilled`, which the assembler flags global+explicit — so before this
 * they were never recorded and every redeploy fell back to the default.
 */
describe('applyVariableDefaults — a redeploy reuses the recorded per-service values (#2785)', () => {
  const solaris = {
    SOLARIS_WHISPER_MODEL: { type: 'text', default: 'base' },
    SOLARIS_TTS_SPEAKER: { type: 'text', default: 'thorsten' },
  };

  it('restores a recorded per-service value over the template default', async () => {
    mockReg.getTemplateVariables.mockResolvedValue(solaris);
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [
        { varName: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', service: 'solaris', default: 'base' },
      ],
    });
    // The redeploy: the replayed manifest carries the slot empty.
    const out = await applyVariableDefaults(input({
      items: [{ name: 'solaris', checked: true }],
      variables: [{ name: 'SOLARIS_WHISPER_MODEL', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'SOLARIS_WHISPER_MODEL')?.value).toBe('large-v3');
  });

  it('adds a recorded per-service variable the replayed manifest never had', async () => {
    mockReg.getTemplateVariables.mockResolvedValue(solaris);
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [
        { varName: 'SOLARIS_WHISPER_MODEL', value: 'large-v3', service: 'solaris', default: 'base' },
      ],
    });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'solaris', checked: true }],
      variables: [],
    }));
    expect(out.variables.find(v => v.name === 'SOLARIS_WHISPER_MODEL')?.value).toBe('large-v3');
  });

  // The other half of the contract: a record whose value is merely what the
  // template shipped is NOT an override, so a template that bumps its default
  // still reaches the box (#1297).
  it('still lets a bumped template default through for a value the operator never changed', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({
      SOLARIS_TTS_SPEAKER: { type: 'text', default: 'kerstin' },
    });
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [
        { varName: 'SOLARIS_TTS_SPEAKER', value: 'thorsten', service: 'solaris', default: 'thorsten' },
      ],
    });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'solaris', checked: true }],
      variables: [{ name: 'SOLARIS_TTS_SPEAKER', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'SOLARIS_TTS_SPEAKER')?.value).toBe('kerstin');
  });

  it('never resolves a recorded secret reference from the plaintext store', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ SOLARIS_TTS_PASSWORD: { type: 'secret' } });
    mockCfg.getConfig.mockResolvedValue({
      installedVariables: [
        { varName: 'SOLARIS_TTS_PASSWORD', value: '', service: 'solaris', kind: 'secret' },
      ],
    });
    const out = await applyVariableDefaults(input({
      items: [{ name: 'solaris', checked: true }],
      variables: [{ name: 'SOLARIS_TTS_PASSWORD', value: '' }],
    }));
    expect(out.variables.find(v => v.name === 'SOLARIS_TTS_PASSWORD')?.value).toBe('');
  });
});
