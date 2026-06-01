/**
 * Post-deploy progress parsing for the install card (#1288).
 *
 * A template's post-deploy script (e.g. OSCAR `ollama`'s model pull) emits
 * structured progress lines on stdout — JSON objects of the shape
 * `{ts, level, tag, message, args}` where `args` carries `{percent,
 * completed_mb, total_mb}` on a progress tick. Those lines stream verbatim
 * through the install-log channel and land in the monitor's `logs` tail.
 *
 * The image-pull phase already gets a user-facing bar; this lets a long
 * post-deploy phase (often the longest step — a multi-GB model download)
 * get the same treatment instead of looking like a silent hang. We parse
 * the most recent progress line out of the log tail and surface it; the
 * card renders it on the same percent bar.
 */

export interface PostDeployProgress {
  /** Producer-supplied tag, e.g. `ollama:pull` — labels the bar. */
  tag?: string;
  /** Human message from the same line, if any. */
  message?: string;
  /** 0–100, clamped. */
  percent: number;
  /** Megabytes downloaded so far, when the producer reports it. */
  completedMb?: number;
  /** Total megabytes, when the producer reports it. */
  totalMb?: number;
}

const clampPercent = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Parse a single log line as a post-deploy progress event, or `null` if it
 * isn't one. A line qualifies when it JSON-parses to an object whose `args`
 * carries a numeric `percent` (the canonical progress field). `completed_mb`
 * / `total_mb` are optional — a percent-only producer still renders a bar.
 */
export function parsePostDeployProgressLine(line: string): PostDeployProgress | null {
  const trimmed = line.trim();
  // Fast reject — every progress line is a JSON object; skip the plain
  // emoji/status lines that dominate the log without paying for a parse.
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const args = obj.args;
  if (typeof args !== 'object' || args === null) return null;
  const a = args as Record<string, unknown>;
  if (!isFiniteNumber(a.percent)) return null;
  return {
    tag: typeof obj.tag === 'string' ? obj.tag : undefined,
    message: typeof obj.message === 'string' ? obj.message : undefined,
    percent: clampPercent(a.percent),
    completedMb: isFiniteNumber(a.completed_mb) ? a.completed_mb : undefined,
    totalMb: isFiniteNumber(a.total_mb) ? a.total_mb : undefined,
  };
}

/**
 * Scan a log tail (oldest→newest) and return the most recent post-deploy
 * progress event, or `null` if none of the lines carry progress. Newest
 * wins so the bar tracks the live tick.
 */
export function latestPostDeployProgress(logs: readonly string[]): PostDeployProgress | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const p = parsePostDeployProgressLine(logs[i]);
    if (p) return p;
  }
  return null;
}
