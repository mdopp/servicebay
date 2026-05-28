/**
 * Fedora CoreOS ISO version-picker model for the launcher TUI (#1238).
 *
 * Pure logic — it parses the upstream stream metadata, merges it with the
 * local ISOs already on disk, marks the host arch, picks a sensible default,
 * and builds the `coreos-installer download` argv. Keeping it free of IO makes
 * the whole picker decision tree unit-testable; the network/fs probes live in
 * isoProbes.ts and the Ink panel in IsoPicker.tsx. Mirrors the bash
 * `select_fedora_coreos_iso` / `fetch_fcos_stream_images` / `detect_host_arch`
 * in install-fedora-coreos.sh rather than re-deriving the logic.
 */
import type { Command } from './actions';

/** The FCoS streams the picker offers, newest-cadence last. */
export const FCOS_STREAMS = ['stable', 'testing', 'next'] as const;
export type FcosStream = (typeof FCOS_STREAMS)[number];

/** Map a `uname -m` value to the arch label FCoS uses. */
export function detectHostArch(machine: string): string {
  switch (machine) {
    case 'x86_64':
      return 'x86_64';
    case 'aarch64':
    case 'arm64':
      return 'aarch64';
    default:
      return machine;
  }
}

/** One metal-ISO build advertised for a stream, per architecture. */
export interface StreamImage {
  arch: string;
  release: string;
  location: string;
}

/** Parse a `streams/<stream>.json` body into its per-arch metal ISO builds.
 *  Tolerant of missing keys: an arch without a metal ISO artifact is skipped
 *  rather than throwing, so a partial/old stream degrades gracefully. */
export function parseStreamImages(json: unknown): StreamImage[] {
  const architectures = (json as { architectures?: Record<string, unknown> } | null)?.architectures;
  if (!architectures || typeof architectures !== 'object') return [];
  const images: StreamImage[] = [];
  for (const [arch, value] of Object.entries(architectures)) {
    const metal = (value as { artifacts?: { metal?: unknown } } | null)?.artifacts?.metal as
      | { release?: unknown; formats?: { iso?: { disk?: { location?: unknown } } } }
      | undefined;
    const release = metal?.release;
    const location = metal?.formats?.iso?.disk?.location;
    if (typeof release === 'string' && typeof location === 'string' && location) {
      images.push({ arch, release, location });
    }
  }
  return images;
}

/** A local ISO already on disk, newest first by the caller. */
export interface LocalIso {
  path: string;
  name: string;
  /** ISO mtime as YYYY-MM-DD, or undefined when unknown. */
  date?: string;
}

/** A selectable image in the picker — either an on-disk ISO or a remote build
 *  to download. `path` is set for local; the stream/arch/location triple is set
 *  for remote. */
export interface IsoChoice {
  kind: 'local' | 'remote';
  label: string;
  path?: string;
  stream?: FcosStream;
  arch?: string;
  location?: string;
  isHostArch?: boolean;
}

function localLabel(iso: LocalIso): string {
  return `${iso.name}  (local, ${iso.date ?? '?'})`;
}

function remoteLabel(stream: FcosStream, image: StreamImage, isHostArch: boolean): string {
  const marker = isHostArch ? '  ← host arch' : '';
  return `${stream.padEnd(8)} ${image.arch.padEnd(8)} ${image.release}${marker}`;
}

/** Combine local ISOs (first, in the order given) with the remote builds for
 *  each stream, marking the host arch. */
export function buildChoices(input: {
  localIsos: LocalIso[];
  remote: { stream: FcosStream; images: StreamImage[] }[];
  hostArch: string;
}): IsoChoice[] {
  const choices: IsoChoice[] = [];
  for (const iso of input.localIsos) {
    choices.push({ kind: 'local', label: localLabel(iso), path: iso.path });
  }
  for (const { stream, images } of input.remote) {
    for (const image of images) {
      const isHostArch = image.arch === input.hostArch;
      choices.push({
        kind: 'remote',
        label: remoteLabel(stream, image, isHostArch),
        stream,
        arch: image.arch,
        location: image.location,
        isHostArch,
      });
    }
  }
  return choices;
}

/** The index to pre-select: first local ISO, else the stable build for the host
 *  arch, else the first choice. -1 when there are no choices at all. */
export function defaultChoiceIndex(choices: IsoChoice[], hostArch: string): number {
  if (choices.length === 0) return -1;
  const firstLocal = choices.findIndex(c => c.kind === 'local');
  if (firstLocal !== -1) return firstLocal;
  const stableHost = choices.findIndex(
    c => c.kind === 'remote' && c.stream === 'stable' && c.arch === hostArch,
  );
  if (stableHost !== -1) return stableHost;
  return 0;
}

/** Build the `coreos-installer download` argv that fetches the chosen remote
 *  build's metal ISO into `buildDir`. */
export function downloadCommand(stream: FcosStream, arch: string, buildDir: string): Command {
  return {
    cmd: 'coreos-installer',
    args: ['download', '-s', stream, '-a', arch, '-p', 'metal', '-f', 'iso', '-C', buildDir],
  };
}
