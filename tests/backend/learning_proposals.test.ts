import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Learning-proposal store (#2326 slice 1): schema validation, namespaced-id
// enforcement + built-in-id collision rejection, and pending persistence.

const dirState = vi.hoisted(() => ({ dir: '/tmp/sb-proposals-boot' }));

vi.mock('@/lib/dirs', () => ({
  get DATA_DIR() {
    return dirState.dir;
  },
}));

// The store's built-in-id collision check reads the catalog's built-in ids.
// Mock the catalog so the test is not coupled to the shipped assists/ dir — we
// pin a known built-in id (`servicebay-overview`) to assert the collision path.
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
  validateProposalContent,
  deriveProposalAssistId,
  ProposalError,
  slugifyTitle,
} from '@/lib/assists/proposals';

const VALID = {
  title: 'How to wire a companion assist',
  whenToUse: 'You want a runtime-only companion to a built-in.',
  kind: 'recipe' as const,
  tags: ['assist', 'companion'],
  body: '# Steps\n\n1. Do the thing.\n',
};

beforeEach(async () => {
  dirState.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-proposals-'));
});

afterEach(async () => {
  await fs.rm(dirState.dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('validateProposalContent', () => {
  it('accepts a well-formed submission', () => {
    const c = validateProposalContent(VALID);
    expect(c.title).toBe(VALID.title);
    expect(c.kind).toBe('recipe');
    expect(c.tags).toEqual(['assist', 'companion']);
  });

  it('rejects a missing title', () => {
    expect(() => validateProposalContent({ ...VALID, title: '' })).toThrow(ProposalError);
    expect(() => validateProposalContent({ ...VALID, title: undefined })).toThrow(/title/);
  });

  it('rejects a missing whenToUse', () => {
    expect(() => validateProposalContent({ ...VALID, whenToUse: '  ' })).toThrow(/whenToUse/);
  });

  it('rejects a missing body', () => {
    expect(() => validateProposalContent({ ...VALID, body: '' })).toThrow(/body/);
  });

  it('rejects an invalid kind', () => {
    expect(() => validateProposalContent({ ...VALID, kind: 'novel' })).toThrow(/kind/);
  });

  it('rejects non-string tags', () => {
    expect(() => validateProposalContent({ ...VALID, tags: [1, 2] })).toThrow(/tags/);
  });
});

describe('deriveProposalAssistId — namespaced + additive-only', () => {
  it('derives a namespaced local/<slug> id', async () => {
    const id = await deriveProposalAssistId('My New Recipe!');
    expect(id).toBe('local/my-new-recipe');
    expect(slugifyTitle('My New Recipe!')).toBe('my-new-recipe');
  });

  it('rejects a title whose slug collides with a built-in id', async () => {
    // `servicebay-overview` is a mocked built-in id above.
    await expect(deriveProposalAssistId('ServiceBay Overview')).rejects.toThrow(/shadow built-in|collides/i);
  });
});

describe('submitProposal — persist as pending', () => {
  it('persists a valid submission as pending and returns id + assistId', async () => {
    const p = await submitProposal(VALID, 'token:agent');
    expect(p.status).toBe('pending');
    expect(p.id).toBeTruthy();
    expect(p.assistId).toBe('local/how-to-wire-a-companion-assist');
    expect(p.submittedBy).toBe('token:agent');

    const all = await listProposals();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(p.id);
    expect(all[0].status).toBe('pending');
  });

  it('rejects a built-in id collision without persisting', async () => {
    await expect(
      submitProposal({ ...VALID, title: 'servicebay-overview' }),
    ).rejects.toThrow(ProposalError);
    expect(await listProposals()).toHaveLength(0);
  });

  it('rejects a bad schema without persisting', async () => {
    await expect(submitProposal({ ...VALID, kind: 'bogus' })).rejects.toThrow(/kind/);
    expect(await listProposals()).toHaveLength(0);
  });
});
