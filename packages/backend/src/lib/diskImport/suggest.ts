// Disk-import engine — LLM suggestion paths feeding the REVIEW PLAN (issue #1695).
//
// Two paths that consult the local Ollama classifier (ollama.ts) on the residue
// the deterministic rules in classify.ts can't resolve:
//   1. Ambiguous media   — a folder the music-vs-audiobook heuristic left
//                          undecided → music | audiobooks | podcasts.
//   2. Document foldering — for the `documents` category, a topic subfolder
//                          (vertraege | steuer | reisen | arbeit | gesundheit | …).
//
// CONTRACT — the classifier is ADVISORY ONLY:
//   * Every suggestion is returned as a ReviewSuggestion and belongs in the
//     review plan (e.g. an `ambiguous.tsv` the human resolves per folder).
//     NOTHING here mutates an ImportPlanItem, writes a target, or changes a
//     record's category. The classifier proposes; the human-approved plan
//     decides. There is no apply path in this module.
//   * Ollama is consulted only when a determinstic answer is absent (the caller
//     gates on the heuristic residue / the documents category). A pure
//     heuristic hit never reaches the LLM.
//   * If Ollama yields no valid suggestion (unreachable, timeout, malformed),
//     the function returns `null` — no suggestion, no throw. Degrade gracefully.

import { requestLabel, type LabelSuggestion, type OllamaClientOptions } from './ollama';
import type { Category } from './types';

/** Which residue path produced a suggestion (for the review-plan grouping). */
export type SuggestionKind = 'ambiguous-media' | 'document-topic';

/**
 * One advisory entry destined for the review plan. It is a SUGGESTION, never an
 * applied decision — the human resolves it (accept / override) per folder before
 * anything is written.
 */
export interface ReviewSuggestion {
  kind: SuggestionKind;
  /** The folder (media) or file (document) the suggestion is about. */
  subject: string;
  /**
   * For `ambiguous-media`: a Category (`music` | `audiobooks` | `podcasts`).
   * For `document-topic`: a topic subfolder name (e.g. `steuer`).
   */
  suggestion: string;
  /** The model's short justification, surfaced to the human in the review plan. */
  reason: string;
}

/** The candidate media categories the LLM may pick from for ambiguous audio. */
const MEDIA_LABELS: readonly Category[] = ['music', 'audiobooks', 'podcasts'];

/**
 * The closed set of document topic folders. The model must pick one of these —
 * a free-text topic would be unparseable downstream. `sonstiges` is the
 * catch-all so the model always has a valid answer.
 */
export const DOCUMENT_TOPICS: readonly string[] = [
  'vertraege',
  'steuer',
  'reisen',
  'arbeit',
  'gesundheit',
  'finanzen',
  'wohnen',
  'sonstiges',
];

/** A compact signature of an ambiguous media folder — metadata only, no bytes. */
export interface MediaFolderSignature {
  /** The folder name / path the human will see in the review plan. */
  folder: string;
  /** A few sample file or track names from the folder. */
  sampleNames: string[];
  /** ID3/metadata genres seen in the folder, if any were extracted. */
  genres?: string[];
  /** Average track length in seconds across the folder, if known. */
  avgTrackLengthSec?: number;
}

/** A compact signature of a document — filename, path, and a cheap text head. */
export interface DocumentSignature {
  /** The file the suggestion is about (shown in the review plan). */
  sourcePath: string;
  /** First KB or so of extracted text (PDF/text), if the caller pulled it. */
  textHead?: string;
}

/**
 * Suggest a media category for a folder the heuristic left ambiguous. Returns a
 * ReviewSuggestion (for the review plan) or `null` (Ollama gave no valid
 * answer). NEVER applies the category to any record — advisory only.
 */
export async function suggestAmbiguousMedia(
  sig: MediaFolderSignature,
  opts?: OllamaClientOptions,
): Promise<ReviewSuggestion | null> {
  const result = await requestLabel(
    { prompt: buildMediaPrompt(sig), allowed: MEDIA_LABELS },
    opts,
  );
  return toReview('ambiguous-media', sig.folder, result);
}

/**
 * Suggest a topic subfolder for a document already classified into `documents`.
 * Returns a ReviewSuggestion (for the review plan) or `null`. Advisory only —
 * the suggested topic is never written into a target path here.
 */
export async function suggestDocumentTopic(
  sig: DocumentSignature,
  opts?: OllamaClientOptions,
): Promise<ReviewSuggestion | null> {
  const result = await requestLabel(
    { prompt: buildDocumentPrompt(sig), allowed: DOCUMENT_TOPICS },
    opts,
  );
  return toReview('document-topic', sig.sourcePath, result);
}

/** Lift a validated LabelSuggestion into a review-plan ReviewSuggestion. */
function toReview(
  kind: SuggestionKind,
  subject: string,
  result: LabelSuggestion | null,
): ReviewSuggestion | null {
  if (!result) return null;
  return { kind, subject, suggestion: result.label, reason: result.reason };
}

function buildMediaPrompt(sig: MediaFolderSignature): string {
  const lines = [
    'Classify this audio folder. Decide if it is music, an audiobook, or a podcast.',
    `Folder name: ${sig.folder}`,
    `Sample track/file names: ${sig.sampleNames.join('; ') || '(none)'}`,
  ];
  if (sig.genres && sig.genres.length > 0) {
    lines.push(`ID3 genres present: ${sig.genres.join(', ')}`);
  }
  if (typeof sig.avgTrackLengthSec === 'number') {
    lines.push(`Average track length: ${Math.round(sig.avgTrackLengthSec)} seconds`);
  }
  return lines.join('\n');
}

function buildDocumentPrompt(sig: DocumentSignature): string {
  const lines = [
    'Suggest the best topic folder for this document from the allowed list.',
    `File path: ${sig.sourcePath}`,
  ];
  if (sig.textHead && sig.textHead.trim().length > 0) {
    // Keep it cheap — only the first chunk of text is ever sent.
    lines.push(`Text excerpt: ${sig.textHead.trim().slice(0, 1024)}`);
  }
  return lines.join('\n');
}
