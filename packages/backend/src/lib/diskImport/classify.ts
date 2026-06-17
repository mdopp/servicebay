// Disk-import engine — classification (issue #1693).
//
// Maps a record → canonical category via the extension index plus deterministic
// heuristics (music-vs-audiobook). The LLM-residue path is NOT implemented here
// — this module only exposes the SEAM (a classifier hook interface) that a later
// issue (#1695, Ollama classifier) plugs into. No LLM is called from here.

import {
  EXTENSION_INDEX,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  JUNK_NAMES,
  JUNK_EXTENSIONS,
  JUNK_PATH_SEGMENTS,
} from './categories';
import type { Category, Disposition, ImportRecord } from './types';

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
  /**
   * Image-vs-video subtree dominance for the record's containing folder
   * (#1914), pre-computed by the caller from the folder's image/video counts
   * (`subtreeMediaProfile`). When the subtree is VIDEO-dominant, a video file
   * is treated as a movie (`movies/` → Jellyfin) rather than personal media
   * (`photos` → Immich). Undefined → no profile → default image-dominant
   * behaviour (video stays `photos`/Immich). Images are unaffected (always
   * `photos`); a single lone video with no profile also stays `photos`.
   */
  subtreeVideoDominant?: boolean;
}

/**
 * Map an explicit, forced-type {@link Disposition} to the canonical category it
 * lands in (#1914). Forced type dispositions OVERRIDE the extension/heuristic
 * classifier — a folder the user marked "Musik" sorts to `music/` regardless of
 * what its files' extensions say. Returns `null` when the disposition does NOT
 * force a content category:
 *   - `auto`                     → run the normal classifier (no force);
 *   - `code_parallel`/`archive_1to1` → STRUCTURE-only (the `parallel` mode/1:1
 *      layout is the intent, not a content type) → classify by content;
 *   - `skip`                     → handled upstream (the folder isn't imported).
 *
 * Every mapped disposition is PLACE-IN-FOLDER, no active push (epic #1901 Q2):
 * the importer only copies files into the category folder the watching service
 * indexes — it never calls a Jellyfin/Navidrome/Immich push API. (Photos are
 * indexed by Immich External Libraries over a read-only mount, #1904.)
 */
export function dispositionCategory(disposition: Disposition): Category | null {
  switch (disposition) {
    case 'photos_immich':
      return 'photos';
    case 'movies_jellyfin':
      return 'movies';
    case 'music':
      return 'music';
    case 'audiobooks':
      return 'audiobooks';
    case 'podcasts':
      return 'podcasts';
    case 'documents_merge':
      return 'documents';
    case 'auto':
    case 'code_parallel':
    case 'archive_1to1':
    case 'skip':
      return null;
  }
}

/**
 * The image/video makeup of a directory subtree (#1914). The caller tallies a
 * folder's records (image vs video extensions) and passes the result so the
 * heuristic can decide image-dominant (→ photos/Immich) vs video-dominant
 * (→ movies/Jellyfin) for that folder's videos.
 */
export interface SubtreeMediaProfile {
  imageCount: number;
  videoCount: number;
}

/**
 * Decide whether a media subtree is VIDEO-dominant (→ `movies/`) from its
 * image/video counts. Video-dominant means the folder is overwhelmingly video
 * with little to no still-photo content — a movie/film collection, not a
 * camera roll. A folder with ANY meaningful image presence is image-dominant
 * (personal media → Immich), since a real camera roll mixes photos and clips.
 *
 * Rule: video-dominant iff there is at least one video AND videos strictly
 * outnumber images by a wide margin (images are < 1/4 of the videos). A folder
 * of only videos is video-dominant; a folder of only images is never
 * video-dominant; a mixed camera roll (lots of photos + some clips) stays
 * image-dominant.
 */
export function isVideoDominant(profile: SubtreeMediaProfile): boolean {
  const { imageCount, videoCount } = profile;
  if (videoCount === 0) return false;
  return imageCount * 4 < videoCount;
}

/** The directory portion of a source path (POSIX/Windows), `''` at the root. */
function dirOf(sourcePath: string): string {
  const norm = sourcePath.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash === -1 ? '' : norm.slice(0, slash);
}

/**
 * Build per-record `subtreeVideoDominant` hints (#1914) from the whole record
 * set: tally each containing FOLDER's image vs video files, then mark every
 * record in a video-dominant folder. Returns a hints map keyed by sourcePath
 * (merged onto any caller-supplied hints) so the planner's `classifyRecord` can
 * split a video-dominant folder's videos to `movies/` while a camera-roll
 * folder's clips stay `photos`/Immich. Folders with no media are untouched.
 *
 * Dominance is judged per immediate folder (not recursively) so a mixed disk
 * with a `Filme/` subdir and a `2021/` camera-roll subdir routes each correctly.
 */
export function buildSubtreeHints(
  records: ReadonlyArray<{ sourcePath: string; ext: string }>,
  base: Record<string, ClassifyHints> = {},
): Record<string, ClassifyHints> {
  const profiles = new Map<string, SubtreeMediaProfile>();
  for (const r of records) {
    if (!r.ext) continue;
    const isImage = IMAGE_EXTENSIONS.has(r.ext);
    const isVideo = VIDEO_EXTENSIONS.has(r.ext);
    if (!isImage && !isVideo) continue;
    const dir = dirOf(r.sourcePath);
    const p = profiles.get(dir) ?? { imageCount: 0, videoCount: 0 };
    if (isImage) p.imageCount += 1;
    else p.videoCount += 1;
    profiles.set(dir, p);
  }

  const hints: Record<string, ClassifyHints> = { ...base };
  for (const r of records) {
    if (!r.ext || !VIDEO_EXTENSIONS.has(r.ext)) continue;
    const profile = profiles.get(dirOf(r.sourcePath));
    if (profile && isVideoDominant(profile)) {
      hints[r.sourcePath] = { ...hints[r.sourcePath], subtreeVideoDominant: true };
    }
  }
  return hints;
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

/**
 * Whether a record is junk (skipped, never copied). Matched by junk name
 * (thumbs.db/.ds_store), junk extension (tmp/cache/…), or a junk path segment
 * (node_modules/.git/.trash/…). Exported so the scan can DROP junk records
 * before the expensive size-collision/hash pass (#1932) — junk that the host
 * `find`-prune can't express (a junk-named file outside a junk dir) is filtered
 * here, and classify still re-checks it so the plan never copies junk.
 */
export function isJunk(record: ImportRecord): boolean {
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
 * Refine a record the extension index placed in `photos`. A still image is
 * always `photos`. A VIDEO is `photos` (personal media → Immich) UNLESS the
 * caller signalled the containing subtree is video-dominant (#1914), in which
 * case it's a movie → `movies/` (Jellyfin). A lone video with no profile stays
 * `photos`.
 */
function refinePhotos(record: ImportRecord, hints: ClassifyHints): Category {
  if (record.ext && VIDEO_EXTENSIONS.has(record.ext) && hints.subtreeVideoDominant) {
    return 'movies';
  }
  return 'photos';
}

/**
 * Classify a record into a canonical category.
 *
 * Order: explicit forced disposition → junk → extension index (with audio +
 * photo/movie refinement) → residue classifier seam. Returns `null` only when
 * nothing — not even the optional residue classifier — can decide (e.g. an
 * unknown extension with no LLM hook supplied). A `null` result is left for the
 * human review gate.
 *
 * @param disposition the folder's effective forced-type disposition (#1901). A
 *   type disposition (`music`, `movies_jellyfin`, …) OVERRIDES the extension
 *   classifier — `dispositionCategory` decides; junk is still filtered first so
 *   a `Thumbs.db` in a "Musik" folder isn't copied. `auto`/structure/`skip`
 *   dispositions (or omitting it) run the normal classifier.
 */
export function classifyRecord(
  record: ImportRecord,
  hints: ClassifyHints = {},
  residue?: ResidueClassifier,
  disposition: Disposition = 'auto',
): Category | null {
  if (isJunk(record)) return 'junk';

  // An explicit forced-type disposition wins over the content classifier.
  const forced = dispositionCategory(disposition);
  if (forced) return forced;

  const byExt = record.ext ? EXTENSION_INDEX.get(record.ext) : undefined;
  if (byExt) {
    // `music` is ambiguous (an mp3 may be an audiobook/podcast); `photos` holds
    // both stills and video (a video-dominant subtree splits off to `movies`).
    // Every other extension maps straight through.
    if (byExt === 'music') return refineAudio(record, hints);
    if (byExt === 'photos') return refinePhotos(record, hints);
    return byExt;
  }

  // Unknown extension — hand to the residue classifier seam if one is wired in.
  return residue ? residue.suggest(record, hints) : null;
}
