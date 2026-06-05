import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as suggestModule from './suggest';
import {
  suggestAmbiguousMedia,
  suggestDocumentTopic,
  DOCUMENT_TOPICS,
  type ReviewSuggestion,
} from './suggest';
import * as ollama from './ollama';

// The suggestion paths consult the Ollama client (ollama.ts). We mock that
// client so these tests assert the WIRING + the review-plan contract, never a
// real HTTP call.
vi.mock('./ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ollama')>();
  return { ...actual, requestLabel: vi.fn() };
});

const requestLabel = vi.mocked(ollama.requestLabel);

beforeEach(() => {
  requestLabel.mockReset();
});

describe('suggestAmbiguousMedia — review-plan suggestion only', () => {
  it('valid label → a ReviewSuggestion (advisory, never an applied category)', async () => {
    requestLabel.mockResolvedValue({ label: 'audiobooks', reason: 'long chapters, numbered' });
    const out = await suggestAmbiguousMedia({
      folder: '/disk/Dune',
      sampleNames: ['ch01.mp3', 'ch02.mp3'],
      avgTrackLengthSec: 2400,
    });
    expect(out).toEqual<ReviewSuggestion>({
      kind: 'ambiguous-media',
      subject: '/disk/Dune',
      suggestion: 'audiobooks',
      reason: 'long chapters, numbered',
    });
    // The result is a plain suggestion record — it carries no plan item, no
    // target path, nothing that could be applied directly.
    expect(out).not.toHaveProperty('target');
    expect(out).not.toHaveProperty('action');
  });

  it('Ollama unreachable (null) → null, degrades gracefully', async () => {
    requestLabel.mockResolvedValue(null);
    const out = await suggestAmbiguousMedia({ folder: '/disk/x', sampleNames: ['a.mp3'] });
    expect(out).toBeNull();
  });

  it('passes a closed media label set to the client', async () => {
    requestLabel.mockResolvedValue(null);
    await suggestAmbiguousMedia({ folder: '/disk/x', sampleNames: ['a.mp3'] });
    expect(requestLabel.mock.calls[0][0].allowed).toEqual(['music', 'audiobooks', 'podcasts']);
  });
});

describe('suggestDocumentTopic — review-plan suggestion only', () => {
  it('valid topic → a ReviewSuggestion keyed to the file', async () => {
    requestLabel.mockResolvedValue({ label: 'steuer', reason: 'tax assessment letter' });
    const out = await suggestDocumentTopic({
      sourcePath: '/disk/scan_2023.pdf',
      textHead: 'Finanzamt Bescheid Einkommensteuer 2023',
    });
    expect(out).toEqual<ReviewSuggestion>({
      kind: 'document-topic',
      subject: '/disk/scan_2023.pdf',
      suggestion: 'steuer',
      reason: 'tax assessment letter',
    });
  });

  it('malformed/no suggestion (null) routes to no-suggestion, never crashes', async () => {
    requestLabel.mockResolvedValue(null);
    await expect(
      suggestDocumentTopic({ sourcePath: '/disk/mystery.pdf' }),
    ).resolves.toBeNull();
  });

  it('passes the closed DOCUMENT_TOPICS set to the client', async () => {
    requestLabel.mockResolvedValue(null);
    await suggestDocumentTopic({ sourcePath: '/disk/x.pdf' });
    expect(requestLabel.mock.calls[0][0].allowed).toBe(DOCUMENT_TOPICS);
  });
});

describe('advisory-only invariant', () => {
  it('a suggestion never exposes an apply/write surface', async () => {
    requestLabel.mockResolvedValue({ label: 'music', reason: 'short pop tracks' });
    const media = await suggestAmbiguousMedia({ folder: '/disk/Hits', sampleNames: ['01.mp3'] });
    // Only the four advisory fields exist — nothing that mutates a plan.
    expect(Object.keys(media ?? {}).sort()).toEqual(['kind', 'reason', 'subject', 'suggestion']);
  });

  it('the module exposes no apply/write function', () => {
    const exported = Object.keys(suggestModule);
    expect(exported.some((n) => /apply|write|commit|mutat/i.test(n))).toBe(false);
  });
});
