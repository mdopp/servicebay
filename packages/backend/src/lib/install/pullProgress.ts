/**
 * Aggregates an image pull's per-layer progress events into a single
 * human-readable summary line.
 *
 * Podman's docker-compat `/images/create` stream emits one event per layer:
 *   { id, status: 'Already exists' | 'Pulling fs layer' | 'Downloading' |
 *                 'Download complete' | 'Pull complete' | …,
 *     progressDetail: { current, total } }   // current/total only while Downloading
 *
 * The install runner feeds every event here and periodically logs `describe()`,
 * so the operator always sees forward motion — including how many layers were
 * already cached on the box — instead of a silent multi-GB pull that looks hung.
 * Pure (no IO) so it's unit-testable against the real event shapes.
 */
export interface PullEvent {
  id?: string;
  status?: string;
  current?: number;
  total?: number;
}

export interface PullSummary {
  totalLayers: number;
  cached: number; // "Already exists" — already on the box
  complete: number; // finished downloading/extracting this run
  bytesCurrent: number; // downloaded so far across layers with known sizes
  bytesTotal: number; // known total across those layers
}

const COMPLETE_STATUSES = new Set(['Download complete', 'Pull complete', 'Already exists']);

export class PullTracker {
  private readonly layers = new Map<string, { status: string; current: number; total: number }>();

  update(ev: PullEvent): void {
    if (!ev.id) return;
    const layer = this.layers.get(ev.id) ?? { status: '', current: 0, total: 0 };
    if (ev.status) layer.status = ev.status;
    if (typeof ev.total === 'number' && ev.total > 0) layer.total = ev.total;
    if (typeof ev.current === 'number') layer.current = ev.current;
    this.layers.set(ev.id, layer);
  }

  summary(): PullSummary {
    let cached = 0;
    let complete = 0;
    let bytesCurrent = 0;
    let bytesTotal = 0;
    for (const layer of this.layers.values()) {
      if (layer.status === 'Already exists') {
        cached += 1;
        continue;
      }
      const done = COMPLETE_STATUSES.has(layer.status);
      if (done) complete += 1;
      if (layer.total > 0) {
        bytesTotal += layer.total;
        // A finished layer reports empty progressDetail, so credit its full size.
        bytesCurrent += done ? layer.total : Math.min(layer.current, layer.total);
      }
    }
    return { totalLayers: this.layers.size, cached, complete, bytesCurrent, bytesTotal };
  }
}

/** Render a one-line summary. `fmtBytes` formats a byte count (injected so this
 *  stays free of the runner's private humanBytes). Returns null before any
 *  layer has been seen. */
export function describePull(
  image: string,
  s: PullSummary,
  fmtBytes: (n: number) => string,
): string | null {
  if (s.totalLayers === 0) return null;
  const cachedNote = s.cached > 0 ? ` · ${s.cached} layer${s.cached === 1 ? '' : 's'} already cached` : '';
  if (s.bytesTotal > 0) {
    const pct = Math.min(100, Math.round((s.bytesCurrent / s.bytesTotal) * 100));
    return `Pulling ${image}: ${pct}% (${fmtBytes(s.bytesCurrent)} / ${fmtBytes(s.bytesTotal)})${cachedNote}`;
  }
  // No byte sizes yet — layers are being enumerated / extracted.
  return `Pulling ${image}: preparing ${s.totalLayers} layer${s.totalLayers === 1 ? '' : 's'}${cachedNote}…`;
}
