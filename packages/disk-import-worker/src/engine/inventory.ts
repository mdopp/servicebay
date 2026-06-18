// Disk-import engine — inventory (issue #1693).
//
// Turns a PROVIDED scanned file list into ImportRecords. This step is
// metadata-first: it never walks a disk, never reads file contents, and never
// touches the host. The caller (a later CLI / host-apply issue) does the actual
// `lsblk`/walk and hands the file list in.

import type { ImportRecord } from './types';

/** A raw scanned file as provided by the (external) disk walker. */
export interface ScannedFile {
  /** Path on the imported tree. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time, epoch milliseconds. */
  mtimeMs: number;
  /**
   * Optional pre-computed content hash (sha256 hex). Usually absent here —
   * hashing is deferred to the dedup step, which only hashes size-collision
   * candidates.
   */
  sha256?: string;
}

/**
 * Extract the lower-cased extension (no leading dot) from a path. A leading-dot
 * file with no other dot (e.g. `.DS_Store`) has no extension — the dot is part
 * of the name, not a separator.
 */
export function extOf(filePath: string): string {
  const base = baseName(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or leading-dot dotfile
  return base.slice(dot + 1).toLowerCase();
}

/** Lower-cased final path segment, tolerating both `/` and `\` separators. */
export function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const trimmed = norm.endsWith('/') ? norm.slice(0, -1) : norm;
  const slash = trimmed.lastIndexOf('/');
  return (slash === -1 ? trimmed : trimmed.slice(slash + 1)).toLowerCase();
}

/** Turn one scanned file into a metadata record. */
export function toRecord(file: ScannedFile): ImportRecord {
  return {
    sourcePath: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ext: extOf(file.path),
    name: baseName(file.path),
    sha256: file.sha256,
  };
}

/**
 * Build the record inventory from a provided scanned file list. Deterministic:
 * records are returned sorted by source path so a given input always yields the
 * same ordered plan downstream.
 */
export function buildInventory(files: ScannedFile[]): ImportRecord[] {
  return files
    .map(toRecord)
    .sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0));
}
