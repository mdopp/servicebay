/**
 * Concrete IO for the ISO version-picker (#1238): fetch upstream FCoS stream
 * metadata over HTTP and enumerate the ISOs already on disk. Kept apart from
 * isoPicker.ts so the picker model stays pure and testable.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './actions';
import {
  FCOS_STREAMS,
  detectHostArch,
  parseStreamImages,
  type FcosStream,
  type LocalIso,
  type StreamImage,
} from './isoPicker';

export const BUILD_DIR = path.join(REPO_ROOT, 'build', 'fcos');
const STREAM_FETCH_TIMEOUT_MS = 15000;
const CUSTOM_ISO = 'fedora-coreos-custom.iso';

export function hostArch(): string {
  return detectHostArch(os.machine());
}

/** A local ISO plus its mtime, used only for newest-first sorting. */
type DatedIso = LocalIso & { mtimeMs: number };

/** Fetch the metal-ISO builds for one stream. Returns [] on any network/parse
 *  failure so the picker degrades to whatever else is reachable. */
export async function fetchStreamImages(stream: FcosStream): Promise<StreamImage[]> {
  try {
    const res = await fetch(`https://builds.coreos.fedoraproject.org/streams/${stream}.json`, {
      signal: AbortSignal.timeout(STREAM_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseStreamImages(await res.json());
  } catch {
    return [];
  }
}

/** Fetch every stream's builds in parallel, dropping the empty ones. */
export async function fetchAllStreams(): Promise<{ stream: FcosStream; images: StreamImage[] }[]> {
  const results = await Promise.all(
    FCOS_STREAMS.map(async stream => ({ stream, images: await fetchStreamImages(stream) })),
  );
  return results.filter(r => r.images.length > 0);
}

async function isoFilesIn(dir: string): Promise<DatedIso[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const isos = await Promise.all(
    entries
      .filter(name => name.endsWith('.iso') && name !== CUSTOM_ISO)
      .map(async (name): Promise<DatedIso | null> => {
        const full = path.join(dir, name);
        try {
          const stat = await fs.stat(full);
          return { path: full, name, mtimeMs: stat.mtimeMs, date: isoDate(stat.mtime) };
        } catch {
          return null;
        }
      }),
  );
  return isos.filter((i): i is DatedIso => i !== null);
}

function isoDate(mtime: Date): string {
  return mtime.toISOString().slice(0, 10);
}

/** List local ISOs across the repo root, build/, and build/fcos/, newest first,
 *  excluding the customised install ISO. */
export async function listLocalIsos(): Promise<LocalIso[]> {
  const dirs = [REPO_ROOT, path.join(REPO_ROOT, 'build'), BUILD_DIR];
  const groups = await Promise.all(dirs.map(isoFilesIn));
  const byPath = new Map<string, DatedIso>();
  for (const iso of groups.flat()) byPath.set(iso.path, iso);
  return [...byPath.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ path: p, name, date }) => ({ path: p, name, date }));
}
