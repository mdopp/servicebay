'use client';

import { Loader2, KeyRound } from 'lucide-react';
import { useInstallMonitor, type InstallMonitorState } from '@/hooks/useInstallMonitor';

/**
 * Live install-progress card for the Home dashboard (#A). When an
 * install is running on the box, every connected web client sees the
 * same thing the sb-tui monitor shows: the current item, deployed/total
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

// phaseLabel maps a raw job phase to a human label — mirrors the sb-tui
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
  const { phase, currentItem, deployed, total, percent, needsCredentials, logs } = state;
  return (
    <div className="rounded-2xl p-5 glass-panel border border-blue-500/20 bg-gradient-to-br from-blue-500/10 to-indigo-500/5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Loader2 size={18} className="text-blue-500 shrink-0 animate-spin" />
          {phaseLabel(phase)}
          {currentItem && <span className="font-medium text-gray-500 dark:text-gray-400">· {currentItem}</span>}
        </h2>
        {total > 0 && (
          <span className="text-sm font-semibold text-blue-600 dark:text-blue-400 shrink-0 tabular-nums">
            {deployed}/{total}
          </span>
        )}
      </div>

      {/* Percent bar (% = deployed/total). */}
      <div className="space-y-1">
        <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{percent}%</p>
      </div>

      {/* The runner paused on the NPM credentials prompt. Skipping
          continues with the auto-generated fallback; proxy routes can
          be set later in Settings → Networking & Access. */}
      {needsCredentials && (
        <div className="rounded-xl border border-amber-300/60 dark:border-amber-800/50 bg-amber-50/80 dark:bg-amber-950/20 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
            Waiting for reverse-proxy credentials. Skip to continue with auto-generated ones — you can set them later in Settings.
          </p>
          <button
            type="button"
            onClick={onSkipCredentials}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors"
          >
            <KeyRound size={13} /> Skip credentials
          </button>
        </div>
      )}

      {/* Log tail — the last few install-runner lines, monospaced. */}
      {logs.length > 0 && (
        <pre className="text-[11px] leading-relaxed font-mono text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-black/30 rounded-xl p-3 overflow-x-auto max-h-44 whitespace-pre-wrap break-words">
          {logs.join('\n')}
        </pre>
      )}
    </div>
  );
}
