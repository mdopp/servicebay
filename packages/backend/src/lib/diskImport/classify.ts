// Disk-import engine — classification (issue #1693).
//
// Maps a record → canonical category via the extension index plus deterministic
// heuristics (music-vs-audiobook). The LLM-residue path is NOT implemented here
// — this module only exposes the SEAM (a classifier hook interface) that a later
// issue (#1695, Ollama classifier) plugs into. No LLM is called from here.

import {
  EXTENSION_INDEX,
  JUNK_NAMES,
  JUNK_EXTENSIONS,
  JUNK_PATH_SEGMENTS,
} from './categories';
import type { Category, ImportRecord } from './types';

/**
 * A hint the heuristic can act on without reading file content. These come from
 * the path / metadata only (the engine never opens the file). A later step may
 * enrich them (e.g. ID3 genre, average track length) before re-classifying.
 */
export interface ClassifyHints {
  /** ID3/metadata genre, lower-cased, if the caller extracted one. */
  genre?: string;
  /** Average track length in seconds, if known (long → audiobook/podcast). */
  avgTrackLengthSec?: number;
  /** Whether the file name / siblings look chapter-numbered (audiobook). */
  chapterNaming?: boolean;
}

/**
 * Optional residue classifier (the LLM seam). When the deterministic rules
 * can't decide (returns `null`), an implementation of this interface — wired in
 * a LATER issue — may suggest a category. It is never called from this module;
 * `classifyRecord` accepts it only as an injected dependency so callers can
 * pass an Ollama-backed impl without this module importing one.
 */
export interface ResidueClassifier {
  /** Return a category suggestion, or `null` to leave it unclassified. */
  suggest(record: ImportRecord, hints: ClassifyHints): Category | null;
}

/** Path segments (lower-cased) that strongly imply an audiobook. */
const AUDIOBOOK_PATH_HINTS = ['audiobook', 'audio book', 'hörbuch', 'hoerbuch'];
/** Path segments (lower-cased) that strongly imply a podcast. */
const PODCAST_PATH_HINTS = ['podcast'];
/** Genre values (lower-cased) that imply spoken-word, not music. */
const SPOKEN_GENRES = new Set(['audiobook', 'audio book', 'speech', 'spoken', 'spoken word', 'podcast']);

/** A long track (> 30 min) is far more likely an audiobook chapter than a song. */
const LONG_TRACK_SEC = 30 * 60;

function isJunk(record: ImportRecord): boolean {
  if (JUNK_NAMES.has(record.name)) return true;
  if (record.ext && JUNK_EXTENSIONS.has(record.ext)) return true;
  const lowerPath = record.sourcePath.replace(/\\/g, '/').toLowerCase();
  return JUNK_PATH_SEGMENTS.some(seg => lowerPath.includes(`/${seg}/`) || lowerPath.startsWith(`${seg}/`));
}

/**
 * Disambiguate an audio file that the extension map placed in `music`. Returns
 * the refined category. Deterministic and content-free — uses only the path and
 * any caller-provided hints.
 */
function refineAudio(record: ImportRecord, hints: ClassifyHints): Category {
  const lowerPath = record.sourcePath.replace(/\\/g, '/').toLowerCase();

  if (PODCAST_PATH_HINTS.some(h => lowerPath.includes(h))) return 'podcasts';
  if (AUDIOBOOK_PATH_HINTS.some(h => lowerPath.includes(h))) return 'audiobooks';

  if (hints.genre) {
    const g = hints.genre.toLowerCase();
    if (g.includes('podcast')) return 'podcasts';
    if (SPOKEN_GENRES.has(g)) return 'audiobooks';
  }

  if (hints.chapterNaming) return 'audiobooks';
  if (typeof hints.avgTrackLengthSec === 'number' && hints.avgTrackLengthSec >= LONG_TRACK_SEC) {
    return 'audiobooks';
  }

  return 'music';
}

/**
 * Classify a record into a canonical category.
 *
 * Order: junk → extension index → audio refinement → residue classifier seam.
 * Returns `null` only when nothing — not even the optional residue classifier —
 * can decide (e.g. an unknown extension with no LLM hook supplied). A `null`
 * result is left for the human review gate in a later issue.
 */
export function classifyRecord(
  record: ImportRecord,
  hints: ClassifyHints = {},
  residue?: ResidueClassifier,
): Category | null {
  if (isJunk(record)) return 'junk';

  const byExt = record.ext ? EXTENSION_INDEX.get(record.ext) : undefined;
  if (byExt) {
    // Only the `music` bucket is ambiguous (an mp3 may really be an audiobook
    // or podcast). m4b/aax etc. already landed in `audiobooks` unambiguously,
    // and every non-audio extension maps straight through.
    return byExt === 'music' ? refineAudio(record, hints) : byExt;
  }

  // Unknown extension — hand to the residue classifier seam if one is wired in.
  return residue ? residue.suggest(record, hints) : null;
}
