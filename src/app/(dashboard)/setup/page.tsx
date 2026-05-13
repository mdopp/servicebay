'use client';

/**
 * /setup — non-blocking install workspace.
 *
 * The wizard's install phase used to monopolise the screen with a
 * full-bleed modal: while the deploy ran the operator couldn't open
 * Terminal to tail a log, peek at /services, or check Diagnose. That's
 * uncomfortable for a 10-minute first-boot install where everything
 * useful is right *behind* the modal.
 *
 * Now: once an install job is registered server-side (the wizard hits
 * /api/install/start) the modal becomes minimisable, a "Setup" entry
 * pops into the sidebar, and this page is the always-available view of
 * the current job. Every connected client sees the same logs because
 * the source of truth is the persisted job under /app/data/install-jobs,
 * not per-tab React state. When the job lands in a terminal phase
 * (`done` / `error` / `aborted` / `crashed`), the operator can click
 * "Finish" — it clears `stackSetupPending` so the wizard stops
 * auto-opening for everyone and the sidebar entry disappears.
 *
 * Deliberately spare: no input collection here, no per-template config.
 * That stays in the wizard (which the operator can re-open any time).
 * This page is just "what is the install doing right now, and what did
 * it log?". For richer interaction (re-running a failed seed, etc.)
 * operators land on Health → Diagnose.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, AlertTriangle, Loader2, KeyRound, Maximize2 } from 'lucide-react';
import { completeStackSetup } from '@/app/actions/onboarding';
import type { JobPhase, JobState } from '@/lib/install/jobStore';

interface StatusResponse {
  job: JobState | null;
  logs: string;
  logsOffset: number;
}

const POLL_INTERVAL_MS = 2000;

function phaseChrome(phase: JobPhase): { label: string; tone: 'info' | 'warn' | 'success' | 'error'; Icon: typeof Loader2 } {
  switch (phase) {
    case 'running':           return { label: 'Installing', tone: 'info', Icon: Loader2 };
    case 'needs_credentials': return { label: 'Needs credentials', tone: 'warn', Icon: KeyRound };
    case 'done':              return { label: 'Finished', tone: 'success', Icon: CheckCircle2 };
    case 'error':             return { label: 'Error', tone: 'error', Icon: AlertTriangle };
    case 'aborted':           return { label: 'Aborted', tone: 'warn', Icon: AlertTriangle };
    case 'crashed':           return { label: 'Crashed', tone: 'error', Icon: AlertTriangle };
  }
}

const TONE_CLASSES: Record<'info' | 'warn' | 'success' | 'error', string> = {
  info:    'text-blue-700 bg-blue-100 dark:text-blue-200 dark:bg-blue-900/40',
  warn:    'text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-900/40',
  success: 'text-emerald-700 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-900/40',
  error:   'text-rose-700 bg-rose-100 dark:text-rose-200 dark:bg-rose-900/40',
};

const TERMINAL_PHASES: JobPhase[] = ['done', 'error', 'aborted', 'crashed'];

export default function SetupPage() {
  const router = useRouter();
  const [job, setJob] = useState<JobState | null>(null);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const logsOffsetRef = useRef(0);
  const logViewRef = useRef<HTMLPreElement>(null);
  const lastJobIdRef = useRef<string | null>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const url = lastJobIdRef.current
          ? `/api/install/status?jobId=${encodeURIComponent(lastJobIdRef.current)}&logsSince=${logsOffsetRef.current}`
          : '/api/install/status';
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data: StatusResponse = await res.json();
        if (cancelled) return;

        if (data.job?.id && data.job.id !== lastJobIdRef.current) {
          lastJobIdRef.current = data.job.id;
          logsOffsetRef.current = 0;
          setLogs('');
        }
        setJob(data.job);
        if (data.logs) {
          setLogs(prev => prev + data.logs);
          logsOffsetRef.current = data.logsOffset;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = logViewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const el = logViewRef.current;
    if (!el) return;
    // Re-enable auto-scroll only when the user is at the very bottom.
    autoScrollRef.current = el.scrollHeight - (el.scrollTop + el.clientHeight) < 8;
  };

  const handleFinish = async () => {
    setFinishing(true);
    try {
      await completeStackSetup();
      router.push('/services');
      router.refresh();
    } finally {
      setFinishing(false);
    }
  };

  const reopenWizard = () => {
    // The wizard listens for this on the window so it can re-render
    // even when minimised. Defined in OnboardingWizard.tsx.
    window.dispatchEvent(new CustomEvent('servicebay:open-wizard'));
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
        <Loader2 className="animate-spin mr-2" size={20} /> Loading install status…
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <CheckCircle2 className="text-emerald-500 mb-3" size={36} />
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">No install in progress</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 max-w-md">
          Open Services to manage what&apos;s deployed, or start a new install from
          the wizard.
        </p>
      </div>
    );
  }

  const { label, tone, Icon } = phaseChrome(job.phase);
  const isTerminal = TERMINAL_PHASES.includes(job.phase);
  const progress = job.progress;
  const itemsLine = progress?.totalCount
    ? `${progress.deployedNames.length} of ${progress.totalCount} deployed${progress.currentItem ? ` — currently: ${progress.currentItem}` : ''}`
    : null;

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${TONE_CLASSES[tone]}`}>
            <Icon size={14} className={job.phase === 'running' ? 'animate-spin' : ''} />
            {label}
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">Install in progress</h1>
            {itemsLine && (
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{itemsLine}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={reopenWizard}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
            title="Re-open the install wizard"
          >
            <Maximize2 size={13} /> Open wizard
          </button>
          {isTerminal && (
            <button
              type="button"
              onClick={handleFinish}
              disabled={finishing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
            >
              {finishing ? <Loader2 className="animate-spin" size={13} /> : <CheckCircle2 size={13} />}
              Finish
            </button>
          )}
        </div>
      </header>

      {job.error && (
        <div className="mx-6 mt-4 p-3 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-900/20 text-sm text-rose-800 dark:text-rose-200">
          {job.error}
        </div>
      )}

      <pre
        ref={logViewRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto m-6 mt-4 p-4 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed"
      >
        {logs || (job.phase === 'running' ? 'Waiting for log output…' : 'No log output captured.')}
      </pre>
    </div>
  );
}
