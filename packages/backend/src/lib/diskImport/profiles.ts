// Disk-import — saved ROUTING PRESETS (#2007).
//
// The routing tree (#2000) lets the operator assign owner + target per folder — on
// a real disk that's 30+ deliberate picks that today live only in the page's React
// state and vanish on reload/re-scan. A preset persists that explicit rule map
// (relDir → Rule) under servicebay's data dir so the operator can re-load it on a
// fresh scan and go straight to "Re-plan & import" with zero re-entry.
//
// Manual, NAMED presets (operator's call) — no disk-signature auto-recall. These are
// servicebay's OWN files (DATA_DIR, core-owned), never the worker's `:Z` out dir, so
// there's no SELinux relabel concern (feedback_fileshare_relabel_crashloop).

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Rule } from '@servicebay/disk-import-worker';

import { DATA_DIR } from '@/lib/dirs';

/** Where presets live (one JSON file per preset). Resolved at call time so DATA_DIR
 *  is read live (not frozen at module load) — keeps it testable + env-overridable. */
export function profilesDir(): string {
  return path.join(DATA_DIR, 'disk-import-profiles');
}

/** A saved routing selection. `rules` is the same explicit map the page POSTs to
 *  /replan + /apply; `rootDefault` is the optional disk-default owner. */
export interface RoutingProfile {
  /** Operator-facing display name (free text, as entered). */
  name: string;
  /** relDir → the explicit (partial) Rule the operator set on that folder (`''` = root). */
  rules: Record<string, Rule>;
  /** Optional disk-default / root default applied where no folder sets an owner. */
  rootDefault?: Partial<Rule>;
  /** Epoch ms the preset was last saved (drives newest-first listing). */
  savedAt: number;
}

/**
 * Map a free-text preset name to a SAFE filename stem. Lowercased, non-`[a-z0-9._-]`
 * runs collapsed to `-`, trimmed + length-capped. The original name is preserved
 * inside the file for display; the slug is only the on-disk key (so re-saving the
 * same name overwrites rather than duplicating).
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64);
}

/** Resolve a preset's file path, refusing any name that can't slug to a safe stem. */
function profilePath(name: string): string {
  const stem = slugify(name);
  if (!stem || stem === '.' || stem === '..') {
    throw new Error('disk-import: invalid preset name');
  }
  const dir = profilesDir();
  const file = path.join(dir, `${stem}.json`);
  // Defence in depth: the resolved file must sit directly under the profiles dir.
  if (path.dirname(file) !== dir) {
    throw new Error('disk-import: invalid preset name');
  }
  return file;
}

/** Persist (create or overwrite) a preset; returns the stored record. */
export async function saveProfile(input: {
  name: string;
  rules: Record<string, Rule>;
  rootDefault?: Partial<Rule>;
}): Promise<RoutingProfile> {
  if (!input.name?.trim()) throw new Error('disk-import: preset name required');
  await mkdir(profilesDir(), { recursive: true });
  const profile: RoutingProfile = {
    name: input.name.trim(),
    rules: input.rules ?? {},
    rootDefault: input.rootDefault,
    savedAt: Date.now(),
  };
  await writeFile(profilePath(input.name), JSON.stringify(profile), 'utf-8');
  return profile;
}

/** List all saved presets, newest first. Missing dir → none; corrupt files skipped. */
export async function listProfiles(): Promise<RoutingProfile[]> {
  const dir = profilesDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: RoutingProfile[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(dir, f), 'utf-8')) as RoutingProfile);
    } catch {
      // Skip a corrupt/partial preset rather than failing the whole list.
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Delete a preset by name (idempotent — a missing preset is not an error). */
export async function deleteProfile(name: string): Promise<void> {
  await rm(profilePath(name), { force: true });
}
