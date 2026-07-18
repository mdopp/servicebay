import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Assessment field on learning proposals (#2326 slice 2): persisted when
// provided; proposal valid without it; malformed assessment is rejected.

const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-proposals-s2-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

vi.mock('@/lib/assists/catalog', async (orig) => {
  const actual = await orig<typeof import('@/lib/assists/catalog')>();
  return {
    ...actual,
    listBuiltinAssistIds: vi.fn().mockResolvedValue(['servicebay-overview', 'create-service']),
  };
});

import {
  submitProposal,
  listProposals,
  validateAssessment,
  ProposalError,
} from '@/lib/assists/proposals';

const VALID_BASE = {
  title: 'How to add a runtime companion',
  whenToUse: 'When adding a local-only companion assist.',
  kind: 'recipe' as const,
  tags: ['assist'],
  body: '# Steps\n\n1. Do the thing.\n',
};

const VALID_ASSESSMENT = {
  pros: ['Captures a non-obvious workflow', 'Reusable across sessions'],
  cons: ['Narrow applicability; only useful for local-only assists', 'May go stale if catalog structure changes'],
  redundancyNote: 'none',
};

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-proposals-s2-'));
});

afterEach(async () => {
  await fs.rm(dirState.dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('validateAssessment', () => {
  it('returns undefined for undefined input', () => {
    expect(validateAssessment(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(validateAssessment(null)).toBeUndefined();
  });

  it('accepts a well-formed assessment', () => {
    const a = validateAssessment(VALID_ASSESSMENT);
    expect(a).toBeDefined();
    expect(a!.pros).toEqual(VALID_ASSESSMENT.pros);
    expect(a!.cons).toEqual(VALID_ASSESSMENT.cons);
    expect(a!.redundancyNote).toBe('none');
  });

  it('accepts assessment without redundancyNote', () => {
    const a = validateAssessment({ pros: ['useful'], cons: ['narrow'] });
    expect(a).toBeDefined();
    expect(a!.redundancyNote).toBeUndefined();
  });

  it('rejects a non-object assessment', () => {
    expect(() => validateAssessment('not an object')).toThrow(ProposalError);
    expect(() => validateAssessment(42)).toThrow(ProposalError);
    expect(() => validateAssessment([])).toThrow(ProposalError);
  });

  it('rejects assessment with non-string-array pros', () => {
    expect(() => validateAssessment({ pros: [1, 2], cons: [] })).toThrow(/pros/);
  });

  it('rejects assessment with non-string-array cons', () => {
    expect(() => validateAssessment({ pros: ['ok'], cons: [true] })).toThrow(/cons/);
  });

  it('rejects assessment with non-string redundancyNote', () => {
    expect(() =>
      validateAssessment({ pros: ['ok'], cons: ['ok'], redundancyNote: 123 }),
    ).toThrow(/redundancyNote/);
  });

  it('rejects assessment with missing cons', () => {
    expect(() => validateAssessment({ pros: ['ok'] })).toThrow(/cons/);
  });
});

describe('submitProposal — assessment persisted when provided', () => {
  it('persists assessment on the proposal record', async () => {
    const p = await submitProposal({ ...VALID_BASE, assessment: VALID_ASSESSMENT }, 'token:agent');
    expect(p.assessment).toBeDefined();
    expect(p.assessment!.pros).toEqual(VALID_ASSESSMENT.pros);
    expect(p.assessment!.cons).toEqual(VALID_ASSESSMENT.cons);
    expect(p.assessment!.redundancyNote).toBe('none');

    // confirm it survived the round-trip through the JSON store
    const stored = await listProposals();
    expect(stored[0].assessment).toEqual(p.assessment);
  });

  it('proposal is valid and pending WITHOUT assessment', async () => {
    const p = await submitProposal(VALID_BASE);
    expect(p.status).toBe('pending');
    expect(p.assessment).toBeUndefined();

    const stored = await listProposals();
    expect(stored).toHaveLength(1);
    expect(stored[0].assessment).toBeUndefined();
  });

  it('rejects malformed assessment and does not persist', async () => {
    await expect(
      submitProposal({ ...VALID_BASE, assessment: { pros: 'not-an-array', cons: [] } }),
    ).rejects.toThrow(ProposalError);
    expect(await listProposals()).toHaveLength(0);
  });

  it('rejects assessment with wrong cons type and does not persist', async () => {
    await expect(
      submitProposal({ ...VALID_BASE, assessment: { pros: [], cons: 'bad' } }),
    ).rejects.toThrow(ProposalError);
    expect(await listProposals()).toHaveLength(0);
  });
});
