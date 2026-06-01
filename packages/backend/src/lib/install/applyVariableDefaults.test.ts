import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1297 — applyVariableDefaults merges variables.json defaults into a (possibly
// replayed) JobInput. Mock only the template-metadata source; the merge logic
// is the real code path.
const { mockReg } = vi.hoisted(() => ({ mockReg: { getTemplateVariables: vi.fn() } }));
vi.mock('@/lib/registry', async (orig) => ({
  ...(await orig<typeof import('@/lib/registry')>()),
  getTemplateVariables: mockReg.getTemplateVariables,
}));

import { applyVariableDefaults } from './manifestAssembler';
import type { JobInput } from './jobStore';

function input(partial: Partial<JobInput>): JobInput {
  const base: JobInput = { items: [], variables: [], cleanInstall: false, cleanInstallConfirm: '', templateSource: 'installed', host: 'localhost' };
  return { ...base, ...partial };
}

beforeEach(() => vi.clearAllMocks());

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

  it('does not mutate the caller\'s input', async () => {
    mockReg.getTemplateVariables.mockResolvedValue({ NEW: { default: 'v' } });
    const original = input({ items: [{ name: 'x', checked: true }], variables: [] });
    const out = await applyVariableDefaults(original);
    expect(original.variables).toHaveLength(0); // untouched
    expect(out.variables).toHaveLength(1);
  });
});
