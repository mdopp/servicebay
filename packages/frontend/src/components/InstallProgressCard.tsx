'use client';

import { Loader2, KeyRound } from 'lucide-react';
import { useInstallMonitor, type InstallMonitorState } from '@/hooks/useInstallMonitor';

/**
 * Live install-progress card for the Home dashboard (#A). When an
 * install is running on the box, every connected web client sees the
 * same thing the sb monitor shows: the current item, deployed/total
 * count, a percent bar, and a tail of the install log — plus a "skip
 * credentials" button when the runner pauses on the NPM credentials
 * prompt.
 *
 * Renders nothing when no install is active ({@link useInstallMonitor}
 * returns `null`).
 */
export default function InstallProgressCard() {
  const { state, skipCredentials } = useInstallMonitor();
  if (!state) return null;
  return <InstallProgressCardView state={state} onSkipCredentials={skipCredentials} />;
}

// phaseLabel maps a raw job phase to a human label — mirrors the sb
// monitor's phaseLabel so the web and terminal views read the same.
function phaseLabel(phase: string): string {
  switch (phase) {
    case '': return 'starting…';
    case 'running': return 'Installing';
    case 'needs_credentials': return 'Waiting for configuration';
    case 'done':
    case 'complete': return 'Done';
    case 'failed':
    case 'error': return 'Failed';
    default: return phase;
  }
}

export function InstallProgressCardView({
  state,
  onSkipCredentials,
}: {
  state: InstallMonitorState;
  onSkipCredentials: () => void;
}) {
  const { phase, currentItem, deployed, total, percent, needsCredentials, logs, postDeployProgress } = state;
  return (
    <div className="rounded-2xl p-5 glass-panel border border-accent/20 bg-gradient-to-br from-accent/10 to-accent/5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-text flex items-center gap-2">
          <Loader2 size={18} className="text-accent shrink-0 animate-spin" />
          {phaseLabel(phase)}
          {currentItem && <span className="font-medium text-text-muted">· {currentItem}</span>}
        </h2>
        {total > 0 && (
          <span className="text-sm font-semibold text-status-info shrink-0 tabular-nums">
            {deployed}/{total}
          </span>
        )}
      </div>

      {/* Percent bar (% = deployed/total). */}
      <div className="space-y-1">
        <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-xs text-text-muted tabular-nums">{percent}%</p>
      </div>

      {/* Post-deploy progress bar (#1288). A template's post-deploy step
          (e.g. OSCAR ollama's multi-GB model pull) emits structured
          progress on the install-log stream; we render it on the same bar
          as image pulls so the longest install phase no longer looks like
          a silent hang. Shows only while a tick is in flight. */}
      {postDeployProgress && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
            <span className="truncate">{postDeployProgress.tag ?? 'Post-deploy'}</span>
            <span className="tabular-nums shrink-0">
              {postDeployProgress.completedMb !== undefined && postDeployProgress.totalMb !== undefined
                ? `${Math.round(postDeployProgress.completedMb)} / ${Math.round(postDeployProgress.totalMb)} MB · ${postDeployProgress.percent}%`
                : `${postDeployProgress.percent}%`}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-status-info transition-[width] duration-500"
              style={{ width: `${postDeployProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* The runner paused on the NPM credentials prompt. Skipping
          continues with the auto-generated fallback; proxy routes can
          be set later in Settings → Networking & Access. */}
      {needsCredentials && (
        <div className="rounded-xl border border-status-warn bg-status-warn/10 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-status-warn leading-relaxed">
            Waiting for reverse-proxy credentials. Skip to continue with auto-generated ones — you can set them later in Settings.
          </p>
          <button
            type="button"
            onClick={onSkipCredentials}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-status-warn hover:bg-status-warn/90 text-on-accent transition-colors"
          >
            <KeyRound size={13} /> Skip credentials
          </button>
        </div>
      )}

      {/* Log tail — the last few install-runner lines, monospaced. */}
      {logs.length > 0 && (
        <pre className="text-[11px] leading-relaxed font-mono text-text-muted bg-surface-muted rounded-xl p-3 overflow-x-auto max-h-44 whitespace-pre-wrap break-words">
          {logs.join('\n')}
        </pre>
      )}
    </div>
  );
}
