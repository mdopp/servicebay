'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

// Lenient schemas — only the fields the Home install card reads. The
// canonical job shape lives in @/lib/install/jobStore; passthrough keeps
// us resilient to additive drift (cf. the install.ts contract notes).
const ProgressShapeSchema = z
  .object({
    currentItem: z.string().nullish(),
    deployedNames: z.array(z.string()).default([]),
    totalCount: z.number().default(0),
  })
  .passthrough();

const CurrentSchema = z.object({
  job: z
    .object({ id: z.string(), phase: z.string(), progress: ProgressShapeSchema })
    .passthrough()
    .nullable(),
  jobIsActive: z.boolean(),
});

const ProgressSchema = z.object({
  job: z
    .object({
      phase: z.string(),
      error: z.string().nullish(),
      progress: ProgressShapeSchema,
      needsCredentials: z.boolean().optional(),
    })
    .passthrough(),
  jobIsActive: z.boolean(),
  logs: z.string().optional(),
  logsOffset: z.number().optional(),
});

export interface InstallMonitorState {
  jobId: string;
  phase: string;
  currentItem: string;
  deployed: number;
  total: number;
  percent: number;
  needsCredentials: boolean;
  logs: string[];
}

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;
const MAX_LOG_LINES = 200;

/**
 * Live install monitor for every web client (#A). Polls
 * `GET /api/install/current` to detect an active job and learn its
 * jobId, then `GET /api/install/progress?jobId=&logsSince=` for the
 * phase, percent, and incremental log tail.
 *
 * Returns `null` whenever nothing is installing (the Home card hides on
 * `null`). Self-paced: a slow idle poll while there's no job, a faster
 * poll once one is running. setTimeout-rescheduled (not setInterval) so
 * a slow fetch never overlaps the next tick.
 */
export function useInstallMonitor(): { state: InstallMonitorState | null; skipCredentials: () => Promise<void> } {
  const [state, setState] = useState<InstallMonitorState | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const offsetRef = useRef(0);
  const logsRef = useRef<string[]>([]);

  const skipCredentials = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    try {
      await fetch('/api/install/skip-credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
    } catch { /* the next poll reflects the resumed phase; nothing to do here */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
      jobIdRef.current = null;
      offsetRef.current = 0;
      logsRef.current = [];
      setState(null);
    };

    // Find an active job (and its id) when we aren't tracking one yet.
    const detect = async (): Promise<boolean> => {
      const res = await fetch('/api/install/current', { cache: 'no-store' });
      if (!res.ok) return false;
      const parsed = CurrentSchema.safeParse(await res.json());
      if (!parsed.success) return false;
      if (parsed.data.jobIsActive && parsed.data.job) {
        jobIdRef.current = parsed.data.job.id;
        offsetRef.current = 0;
        logsRef.current = [];
        return true;
      }
      if (state !== null) setState(null);
      return false;
    };

    const pollProgress = async (jobId: string) => {
      const url = `/api/install/progress?jobId=${encodeURIComponent(jobId)}&logsSince=${offsetRef.current}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const parsed = ProgressSchema.safeParse(await res.json());
      if (cancelled || !parsed.success) return;
      const d = parsed.data;
      if (d.logs) {
        for (const line of d.logs.split('\n')) if (line.trim()) logsRef.current.push(line);
        if (logsRef.current.length > MAX_LOG_LINES) logsRef.current = logsRef.current.slice(-MAX_LOG_LINES);
      }
      if (typeof d.logsOffset === 'number') offsetRef.current = d.logsOffset;
      if (!d.jobIsActive) { reset(); return; } // install ended — hide the card
      const deployed = d.job.progress.deployedNames.length;
      const total = d.job.progress.totalCount;
      setState({
        jobId,
        phase: d.job.phase,
        currentItem: d.job.progress.currentItem ?? '',
        deployed,
        total,
        percent: total > 0 ? Math.floor((deployed * 100) / total) : 0,
        needsCredentials: d.job.phase === 'needs_credentials' || !!d.job.needsCredentials,
        logs: logsRef.current.slice(-12),
      });
    };

    const tick = async () => {
      try {
        if (!jobIdRef.current) {
          if (!(await detect()) || cancelled) return;
        }
        if (jobIdRef.current) await pollProgress(jobIdRef.current);
      } catch { /* offline / mid-redeploy — keep the previous value */ }
    };

    const loop = async () => {
      await tick();
      if (!cancelled) timer = setTimeout(loop, jobIdRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void loop();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, skipCredentials };
}
