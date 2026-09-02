'use client';

import { useCallback, useMemo } from 'react';
import { latestPostDeployProgress, type PostDeployProgress } from '@/components/postDeployProgress';
import { useInstallJob } from '@/hooks/useInstallJob';

export interface InstallMonitorState {
  jobId: string;
  phase: string;
  currentItem: string;
  deployed: number;
  total: number;
  percent: number;
  needsCredentials: boolean;
  logs: string[];
  /**
   * Latest structured progress emitted by the current item's post-deploy
   * script (e.g. an OSCAR `ollama` model pull), parsed out of the log tail.
   * `null` when no progress line is in flight — the card renders the bar
   * only while a post-deploy phase is reporting (#1288).
   */
  postDeployProgress: PostDeployProgress | null;
}

const MAX_LOG_LINES = 200;
const VISIBLE_LOG_LINES = 12;

/**
 * Live install monitor for the Home card and the offline banner (#A).
 * A read of `InstallJobProvider` (#2732) shaped for a compact card: `null`
 * whenever nothing is installing (the card hides on `null`), else the
 * phase, percent and the last few log lines of the active job.
 */
export function useInstallMonitor(): { state: InstallMonitorState | null; skipCredentials: () => Promise<void> } {
  const install = useInstallJob();
  const { job, jobIsActive, logs, credentials, skipCredentials: skipJobCredentials } = install;

  const skipCredentials = useCallback(async () => {
    skipJobCredentials();
  }, [skipJobCredentials]);

  const state = useMemo<InstallMonitorState | null>(() => {
    if (!job || !jobIsActive) return null;
    const deployed = job.progress?.deployedNames?.length ?? 0;
    const total = job.progress?.totalCount ?? 0;
    // Scan a fuller buffer, not just the visible tail: a post-deploy
    // progress tick is throttled (~15s) and can scroll past the last 12
    // log lines during a busy model pull, but the bar should persist.
    const recent = logs.slice(-MAX_LOG_LINES);
    return {
      jobId: job.id,
      phase: job.phase,
      currentItem: job.progress?.currentItem ?? '',
      deployed,
      total,
      percent: total > 0 ? Math.floor((deployed * 100) / total) : 0,
      needsCredentials: job.phase === 'needs_credentials' || credentials.prompt,
      logs: recent.slice(-VISIBLE_LOG_LINES),
      postDeployProgress: latestPostDeployProgress(recent),
    };
  }, [job, jobIsActive, logs, credentials.prompt]);

  return { state, skipCredentials };
}
