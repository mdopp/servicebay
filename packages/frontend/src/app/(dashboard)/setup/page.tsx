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
import { Card, Button } from '@/components/ui';
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
  info:    'text-status-info bg-status-info/10',
  warn:    'text-status-warn bg-status-warn/10',
  success: 'text-status-ok bg-status-ok/10',
  error:   'text-status-fail bg-status-fail/10',
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
  pending:    'bg-text-subtle',
  installing: 'bg-status-info animate-pulse',
  deployed:   'bg-status-ok',
  failed:     'bg-status-fail',
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
    <Card padding="sm" className="bg-surface-2">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Service status</p>
        <p className="text-[11px] text-text-muted">
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
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-card text-xs border ${
                s === 'pending'    ? 'border-border text-text-muted opacity-70' :
                s === 'failed'     ? 'border-status-fail/20 bg-status-fail/10 text-status-fail' :
                s === 'deployed'   ? 'border-status-ok/20 bg-status-ok/10 text-status-ok' :
                                     'border-status-info/20 bg-status-info/10 text-status-info'
              }`}
              title={`${item.name}: ${s}`}
            >
              <span className={`w-2 h-2 rounded-full ${DOT_CLASS[s]}`} />
              {item.name}
            </span>
          );
        })}
      </div>
    </Card>
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
    <Card padding="sm" className="bg-status-fail/10 border-status-fail/20 text-sm">
      <div className="flex items-center justify-between mb-2">
        <p className="font-medium text-status-fail">🔑 Credentials — save now</p>
        <Button
          size="sm"
          onClick={handleDownload}
          className="gap-1.5"
          title="Download as Bitwarden / Vaultwarden CSV"
        >
          <Download size={12} /> CSV
        </Button>
      </div>
      <p className="text-xs text-status-fail mb-2">
        Won&apos;t be shown again. Copy to your password manager now or use the CSV button: Vaultwarden → Tools → Import → Bitwarden (csv).
      </p>
      <div className="space-y-1.5 font-mono text-xs">
        {critical.map(c => (
          <div key={c.service} className="border-l-2 border-status-fail/40 pl-2">
            <div className="font-sans font-medium text-text">{c.service}</div>
            <div className="text-status-fail break-all">{c.url}</div>
            <div className="text-status-fail">{c.username} / {c.password}</div>
          </div>
        ))}
      </div>
      {system.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-status-fail">System / disaster-recovery secrets ({system.length})</summary>
          <div className="mt-1 space-y-1 font-mono">
            {system.map(c => (
              <div key={c.service} className="text-status-fail pl-2">
                <span className="font-sans">{c.service}:</span> {c.password}
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
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
    <Card padding="none" className="p-1.5">
      <DoneStepDnsCheck
        domain={domain}
        subdomains={subdomains.map(sv => `${sv.value}.${domain}`)}
      />
    </Card>
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
  running: { bg: 'bg-surface-2',        border: 'border-border',          text: 'text-text-muted',  label: 'Running self-test…',        emoji: '⏳' },
  ok:      { bg: 'bg-status-ok/10',     border: 'border-status-ok/20',    text: 'text-status-ok',   label: 'Self-test passed',          emoji: '✅' },
  warn:    { bg: 'bg-status-warn/10',   border: 'border-status-warn/20',  text: 'text-status-warn', label: 'Self-test: warnings',       emoji: '⚠️' },
  fail:    { bg: 'bg-status-fail/10',   border: 'border-status-fail/20',  text: 'text-status-fail', label: 'Self-test: failures',       emoji: '❌' },
  info:    { bg: 'bg-surface-2',        border: 'border-border',          text: 'text-text-muted',  label: 'Self-test: indeterminate',  emoji: 'ℹ️' },
  error:   { bg: 'bg-status-fail/10',   border: 'border-status-fail/20',  text: 'text-status-fail', label: 'Self-test failed to run',   emoji: '⚠️' },
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
    <div className={`rounded-card border p-3 text-sm ${style.bg} ${style.border}`}>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <p className={`font-medium ${style.text}`}>
          {style.emoji} {style.label}
          {counts && ` — ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail`}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={run}
          disabled={state.status === 'running'}
        >
          {state.status === 'running' ? 'Running…' : 'Run again'}
        </Button>
      </div>
      {state.error && <p className="text-xs text-status-fail">{state.error}</p>}
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
      <p className={`text-xs mt-1 ${style.text} opacity-80`}>
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
        // Once the pinned job hits a terminal phase, drop the pin so
        // the next tick fetches with no jobId — that lets the API
        // hand back a freshly-started install when the operator kicks
        // off a re-deploy. Without this /setup stays glued to the
        // previous finished job and never re-discovers the new one.
        // If nothing newer is running we'll just re-pin to the same
        // terminal job on the next tick; the id-change branch above
        // won't fire (same id), so the log buffer is preserved.
        if (data.job && TERMINAL_PHASES.includes(data.job.phase)) {
          lastJobIdRef.current = null;
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
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <Loader2 className="animate-spin mr-2" size={20} /> Loading install status…
      </div>
    );
  }
  if (!job) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <CheckCircle2 className="text-status-ok mb-3" size={36} />
        <h2 className="text-lg font-semibold text-text">No install in progress</h2>
        <p className="text-sm text-text-muted mt-2 max-w-md">
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
      <header className="px-6 py-4 border-b border-border flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${TONE_CLASSES[tone]}`}>
            <Icon size={14} className={job.phase === 'running' ? 'animate-spin' : ''} />
            {label}
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-text truncate">Install in progress</h1>
            {itemsLine && (
              <p className="text-xs text-text-muted truncate">{itemsLine}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={reopenWizard}
            className="gap-1.5"
            title="Re-open the install wizard"
          >
            <Maximize2 size={13} /> Open wizard
          </Button>
          {isTerminal && (
            <Button
              size="sm"
              onClick={handleFinish}
              disabled={finishing}
              className="gap-1.5"
            >
              {finishing ? <Loader2 className="animate-spin" size={13} /> : <CheckCircle2 size={13} />}
              Finish
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {job.error && (
          <div className="p-3 rounded-card border border-status-fail/20 bg-status-fail/10 text-sm text-status-fail">
            {job.error}
          </div>
        )}

        <ServiceStatusStrip job={job} />

        {job.credentialsManifest && job.credentialsManifest.length > 0 && (
          <CredentialsPanel manifest={job.credentialsManifest} />
        )}

        {isTerminal && <DnsPanel job={job} />}
        <SelfTestPanel job={job} />

        <Card padding="none">
          <button
            type="button"
            onClick={() => setLogsCollapsed(c => !c)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted hover:bg-surface-2"
          >
            <span className="inline-flex items-center gap-1.5">
              {logsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              Install log
            </span>
            <span className="text-[10px] normal-case font-normal text-text-subtle">
              {logs ? `${logs.split('\n').length} lines` : 'no output yet'}
            </span>
          </button>
          {!logsCollapsed && (
            <pre
              ref={logViewRef}
              onScroll={handleScroll}
              className="overflow-auto max-h-[40vh] p-3 text-xs font-mono text-text-muted whitespace-pre-wrap leading-relaxed border-t border-border bg-surface-muted"
            >
              {logs || (job.phase === 'running' ? 'Waiting for log output…' : 'No log output captured.')}
            </pre>
          )}
        </Card>
      </div>
    </div>
  );
}
