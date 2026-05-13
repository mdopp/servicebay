'use client';

/**
 * /setup — non-blocking install workspace.
 *
 * The wizard's install phase used to monopolise the screen with a
 * full-bleed modal: while the deploy ran the operator couldn't open
 * Terminal to tail a log, peek at /services, or check Diagnose. Once
 * an install job is registered server-side the modal is minimisable,
 * a "Setup" entry pops into the sidebar, and this page is the always-
 * available view of the current job.
 *
 * Every connected client sees the same content because the source of
 * truth is the persisted job under /app/data/install-jobs. When the
 * job lands in a terminal phase (`done` / `error` / `aborted` /
 * `crashed`), this page also surfaces the same "what to do next"
 * panels the wizard's Done step shows — credentials, DNS verify,
 * self-test diagnose verdict — so an operator who minimised the
 * modal mid-install can finish here without going back into the
 * wizard. "Finish" clears `stackSetupPending` so the wizard stops
 * auto-opening and the sidebar entry disappears.
 *
 * Deliberately spare: no input collection here, no per-template
 * config. That stays in the wizard (operator can re-open any time).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, AlertTriangle, Loader2, KeyRound, Maximize2, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { completeStackSetup } from '@/app/actions/onboarding';
import type { JobPhase, JobState } from '@/lib/install/jobStore';
import type { Credential } from '@/lib/stackInstall/credentialsManifest';
import { DoneStepDnsCheck } from '@/components/DoneStepDnsCheck';
import DiagnoseProbeList, { type DiagnoseProbe } from '@/components/DiagnoseProbeList';
import { buildBitwardenCsv } from '@/lib/stackInstall/credentialsManifest';

interface StatusResponse {
  job: JobState | null;
  logs: string;
  logsOffset: number;
}

type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_PHASES: JobPhase[] = ['done', 'error', 'aborted', 'crashed'];

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

/**
 * Status of one template across the install. Mirrors the strip the
 * wizard renders in its installing/done state — only here we work
 * straight off the JobState (no Digital Twin coupling), which is
 * enough to give the operator the "deployed / installing / pending"
 * shape at a glance.
 */
function itemStatus(
  name: string,
  job: JobState,
): 'pending' | 'installing' | 'deployed' | 'failed' {
  if (job.progress?.deployedNames?.includes(name)) return 'deployed';
  if (job.progress?.currentItem === name && job.phase === 'running') return 'installing';
  if (job.phase === 'error' && job.error?.toLowerCase().includes(name.toLowerCase())) return 'failed';
  return 'pending';
}

const DOT_CLASS: Record<'pending' | 'installing' | 'deployed' | 'failed', string> = {
  pending:    'bg-gray-300 dark:bg-gray-600',
  installing: 'bg-blue-500 animate-pulse',
  deployed:   'bg-emerald-500',
  failed:     'bg-red-500',
};

function ServiceStatusStrip({ job }: { job: JobState }) {
  const items = job.input.items.filter(i => i.checked && !i.alreadyInstalled);
  if (items.length === 0) return null;
  const counts = items.reduce<Record<string, number>>((a, i) => {
    const s = itemStatus(i.name, job);
    a[s] = (a[s] ?? 0) + 1;
    return a;
  }, {});
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-900/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Service status</p>
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {counts.deployed ?? 0}/{items.length} deployed
          {counts.failed ? ` · ${counts.failed} failed` : ''}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map(item => {
          const s = itemStatus(item.name, job);
          return (
            <span
              key={item.name}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border ${
                s === 'pending'    ? 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 opacity-70' :
                s === 'failed'     ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' :
                s === 'deployed'   ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' :
                                     'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
              }`}
              title={`${item.name}: ${s}`}
            >
              <span className={`w-2 h-2 rounded-full ${DOT_CLASS[s]}`} />
              {item.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Credentials banner — every auto-generated password ServiceBay can't
 * show again. Mirrors the wizard's Summary panel so an operator who
 * minimised mid-install still gets the same "save these now" prompt
 * with the same CSV-export shortcut.
 */
function CredentialsPanel({ manifest }: { manifest: Credential[] }) {
  if (manifest.length === 0) return null;
  const critical = manifest.filter(c => c.importance === 'critical');
  const system = manifest.filter(c => c.importance === 'system');
  const handleDownload = () => {
    const blob = new Blob([buildBitwardenCsv(manifest)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `servicebay-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <p className="font-medium text-rose-800 dark:text-rose-200">🔑 Credentials — save now</p>
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 text-xs px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded"
          title="Download as Bitwarden / Vaultwarden CSV"
        >
          <Download size={12} /> CSV
        </button>
      </div>
      <p className="text-xs text-rose-700 dark:text-rose-300 mb-2">
        Won&apos;t be shown again. Copy to your password manager now or use the CSV button: Vaultwarden → Tools → Import → Bitwarden (csv).
      </p>
      <div className="space-y-1.5 font-mono text-xs">
        {critical.map(c => (
          <div key={c.service} className="border-l-2 border-rose-300 dark:border-rose-700 pl-2">
            <div className="font-sans font-medium text-rose-900 dark:text-rose-100">{c.service}</div>
            <div className="text-rose-700 dark:text-rose-300 break-all">{c.url}</div>
            <div className="text-rose-600 dark:text-rose-400">{c.username} / {c.password}</div>
          </div>
        ))}
      </div>
      {system.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-rose-700 dark:text-rose-300">System / disaster-recovery secrets ({system.length})</summary>
          <div className="mt-1 space-y-1 font-mono">
            {system.map(c => (
              <div key={c.service} className="text-rose-600 dark:text-rose-400 pl-2">
                <span className="font-sans">{c.service}:</span> {c.password}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Drive the same DoneStepDnsCheck the wizard uses. We derive the
 * domain + the list of public-exposure subdomains from job.input.variables
 * — internal/LAN-only subdomains (`.home.arpa`) are intentionally
 * excluded because querying public DNS for them would always fail
 * and surface as a spurious "not resolving" warning.
 */
function DnsPanel({ job }: { job: JobState }) {
  const domainVar = job.input.variables.find(v => v.name === 'PUBLIC_DOMAIN');
  const domain = domainVar?.value;
  // meta is `unknown` at the storage layer — runtime-narrow each entry.
  const subdomains = job.input.variables.filter(v => {
    const meta = (v.meta ?? {}) as { type?: string; exposure?: string };
    return meta.type === 'subdomain' && meta.exposure === 'public' && !!v.value;
  });
  if (!domain || subdomains.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-800/50 p-1.5">
      <DoneStepDnsCheck
        domain={domain}
        subdomains={subdomains.map(sv => `${sv.value}.${domain}`)}
      />
    </div>
  );
}

interface SelfTestState {
  status: 'idle' | 'running' | 'ok' | 'warn' | 'fail' | 'info' | 'error';
  probes: DiagnoseProbe[] | null;
  node: string;
  error: string | null;
}

function classifyProbes(probes: DiagnoseProbe[]): Exclude<SelfTestState['status'], 'idle' | 'running' | 'error'> {
  const counts = probes.reduce<Record<ProbeStatus, number>>(
    (a, p) => { a[p.status] = (a[p.status] ?? 0) + 1; return a; },
    { ok: 0, warn: 0, fail: 0, info: 0 },
  );
  if (counts.fail > 0) return 'fail';
  if (counts.warn > 0) return 'warn';
  if (counts.ok > 0) return 'ok';
  return 'info';
}

const VERDICT_STYLE: Record<Exclude<SelfTestState['status'], 'idle'>, { bg: string; border: string; text: string; label: string; emoji: string }> = {
  running: { bg: 'bg-gray-50 dark:bg-gray-900/40',       border: 'border-gray-200 dark:border-gray-800', text: 'text-gray-700 dark:text-gray-200',       label: 'Running self-test…',          emoji: '⏳' },
  ok:      { bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-800 dark:text-emerald-200', label: 'Self-test passed',           emoji: '✅' },
  warn:    { bg: 'bg-amber-50 dark:bg-amber-900/20',     border: 'border-amber-200 dark:border-amber-800',     text: 'text-amber-800 dark:text-amber-200',     label: 'Self-test: warnings',        emoji: '⚠️' },
  fail:    { bg: 'bg-red-50 dark:bg-red-900/20',         border: 'border-red-200 dark:border-red-800',         text: 'text-red-800 dark:text-red-200',         label: 'Self-test: failures',        emoji: '❌' },
  info:    { bg: 'bg-gray-50 dark:bg-gray-900/40',       border: 'border-gray-200 dark:border-gray-800',       text: 'text-gray-700 dark:text-gray-200',       label: 'Self-test: indeterminate',   emoji: 'ℹ️' },
  error:   { bg: 'bg-red-50 dark:bg-red-900/20',         border: 'border-red-200 dark:border-red-800',         text: 'text-red-800 dark:text-red-200',         label: 'Self-test failed to run',    emoji: '⚠️' },
};

function SelfTestPanel({ job }: { job: JobState }) {
  const [state, setState] = useState<SelfTestState>({ status: 'idle', probes: null, node: 'Local', error: null });
  const isTerminal = TERMINAL_PHASES.includes(job.phase);
  const runRef = useRef(false);

  const run = async () => {
    setState(s => ({ ...s, status: 'running', error: null }));
    try {
      const res = await fetch('/api/system/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { node?: string; probes: DiagnoseProbe[] };
      setState({ status: classifyProbes(data.probes), probes: data.probes, node: data.node || 'Local', error: null });
    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    }
  };

  useEffect(() => {
    // Auto-run once when the job reaches a terminal phase. Manual
    // "Run again" overrides via the explicit click — guarded by
    // `runRef` so we don't fire on every render that happens while
    // the job is settling.
    if (!isTerminal) return;
    if (runRef.current) return;
    runRef.current = true;
    void run();
  }, [isTerminal]);

  if (!isTerminal) return null;

  const style = VERDICT_STYLE[state.status === 'idle' ? 'info' : state.status];
  const counts = state.probes
    ? state.probes.reduce<Record<ProbeStatus, number>>(
        (a, p) => { a[p.status] = (a[p.status] ?? 0) + 1; return a; },
        { ok: 0, warn: 0, fail: 0, info: 0 },
      )
    : null;
  const issues = counts ? counts.warn + counts.fail : 0;

  return (
    <div className={`rounded-lg border p-3 text-sm ${style.bg} ${style.border}`}>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <p className={`font-medium ${style.text}`}>
          {style.emoji} {style.label}
          {counts && ` — ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail`}
        </p>
        <button
          type="button"
          onClick={run}
          disabled={state.status === 'running'}
          className="text-xs px-2 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {state.status === 'running' ? 'Running…' : 'Run again'}
        </button>
      </div>
      {state.error && <p className="text-xs text-red-700 dark:text-red-300">{state.error}</p>}
      {state.probes && issues > 0 && (
        <details className="mt-2 text-xs" open>
          <summary className={`cursor-pointer ${style.text} mb-2`}>
            Details + fix-buttons ({issues} issue{issues === 1 ? '' : 's'})
          </summary>
          <DiagnoseProbeList
            probes={state.probes}
            node={state.node}
            compact
            parentRunning={state.status === 'running'}
            onRefresh={run}
          />
        </details>
      )}
      <p className={`text-xs mt-1 ${style.text} opacity-70`}>
        Re-run any time at <span className="font-mono">Health → Self-Diagnose</span>.
      </p>
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const [job, setJob] = useState<JobState | null>(null);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
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
    window.dispatchEvent(new CustomEvent('servicebay:open-wizard'));
  };

  const isTerminal = useMemo(() => (job ? TERMINAL_PHASES.includes(job.phase) : false), [job]);

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
          Open Services to manage what&apos;s deployed, or start a new install from the wizard.
        </p>
      </div>
    );
  }

  const { label, tone, Icon } = phaseChrome(job.phase);
  const progress = job.progress;
  const itemsLine = progress?.totalCount
    ? `${progress.deployedNames.length} of ${progress.totalCount} deployed${progress.currentItem ? ` — currently: ${progress.currentItem}` : ''}`
    : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-4 shrink-0">
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

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {job.error && (
          <div className="p-3 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-900/20 text-sm text-rose-800 dark:text-rose-200">
            {job.error}
          </div>
        )}

        <ServiceStatusStrip job={job} />

        {job.credentialsManifest && job.credentialsManifest.length > 0 && (
          <CredentialsPanel manifest={job.credentialsManifest} />
        )}

        {isTerminal && <DnsPanel job={job} />}
        <SelfTestPanel job={job} />

        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-800/50">
          <button
            type="button"
            onClick={() => setLogsCollapsed(c => !c)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900/40"
          >
            <span className="inline-flex items-center gap-1.5">
              {logsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              Install log
            </span>
            <span className="text-[10px] normal-case font-normal text-gray-400">
              {logs ? `${logs.split('\n').length} lines` : 'no output yet'}
            </span>
          </button>
          {!logsCollapsed && (
            <pre
              ref={logViewRef}
              onScroll={handleScroll}
              className="overflow-auto max-h-[40vh] p-3 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed border-t border-gray-200 dark:border-gray-800"
            >
              {logs || (job.phase === 'running' ? 'Waiting for log output…' : 'No log output captured.')}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
