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
 * truth is the persisted job under /app/data/install-jobs, read through
 * the one `InstallJobProvider` poll the wizard and the nav badge share
 * (#2732) — so this page and the wizard can never disagree about the
 * job. The progress view itself is the wizard's `<StackInstallProgress>`
 * (per-service rows, log, abort, NPM credentials prompt); nothing here
 * renders a log or a status strip of its own. When the job lands in a
 * terminal phase (`done` / `error` / `aborted` / `crashed`), the same
 * `<StackInstallSummary>` as the wizard's Done step hands the fresh
 * credentials to the hand-over gate, with the DNS verify + self-test
 * verdict underneath — so an operator who minimised the modal
 * mid-install can finish here without going back into the wizard.
 * "Finish" clears `stackSetupPending` so the wizard stops auto-opening
 * and the sidebar entry disappears.
 *
 * Deliberately spare: no input collection here, no per-template
 * config. That stays in the wizard (operator can re-open any time).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, AlertTriangle, Loader2, KeyRound, Maximize2 } from 'lucide-react';
import { completeStackSetup } from '@servicebay/api-client';
import { Card, Button } from '@/components/ui';
import type { Credential, JobPhase } from '@servicebay/api-client';
import { DoneStepDnsCheck } from '@/components/DoneStepDnsCheck';
import DiagnoseProbeList, { type DiagnoseProbe } from '@/components/DiagnoseProbeList';
import { StackInstallProgress, StackInstallSummary, type InstallProgressController } from '@/components/StackInstallFlow';
import { useInstallJob } from '@/hooks/useInstallJob';
import { isFailedPhase, type InstallJobSnapshot } from '@/providers/InstallJobProvider';

type ProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

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
 * Drive the same DoneStepDnsCheck the wizard uses. We derive the
 * domain + the list of public-exposure subdomains from job.input.variables
 * — internal/LAN-only subdomains (`.home.arpa`) are intentionally
 * excluded because querying public DNS for them would always fail
 * and surface as a spurious "not resolving" warning.
 */
function DnsPanel({ job }: { job: InstallJobSnapshot }) {
  const variables = job.input?.variables ?? [];
  const domainVar = variables.find(v => v.name === 'PUBLIC_DOMAIN');
  const domain = domainVar?.value;
  // meta is `unknown` at the storage layer — runtime-narrow each entry.
  const subdomains = variables.filter(v => {
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

function SelfTestPanel({ job }: { job: InstallJobSnapshot }) {
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

const EMPTY_ITEMS: InstallProgressController['items'] = [];
const EMPTY_NAMES: string[] = [];

export default function SetupPage() {
  const router = useRouter();
  const install = useInstallJob();
  const { job, ready, logs, phase, credentials, abort, submitCredentials, skipCredentials } = install;
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  /** The wizard's progress panel reads a `useStackInstall` controller;
   *  here the same shape is built straight from the shared job. No
   *  `reset` — /setup has no local wizard state to start over from. */
  const controller = useMemo<InstallProgressController & { credentialsManifest: Credential[] }>(() => ({
    items: job?.input?.items ?? EMPTY_ITEMS,
    logs,
    phase,
    installingNow: job?.progress?.currentItem ?? null,
    deployedNames: job?.progress?.deployedNames ?? EMPTY_NAMES,
    error: job && isFailedPhase(job.phase) ? job.error ?? 'Install failed.' : null,
    npmCredPrompt: credentials.prompt,
    npmCredFallback: credentials.fallback,
    npmCredError: credentials.error,
    retryNpmCredentials: submitCredentials,
    skipNpmCredentials: skipCredentials,
    abortInstall: abort,
    credentialsManifest: job?.credentialsManifest ?? [],
  }), [job, logs, phase, credentials, abort, submitCredentials, skipCredentials]);

  const handleFinish = async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      await completeStackSetup();
      router.push('/services');
      router.refresh();
    } catch (e) {
      // Without this the spinner just stopped: no error, no navigation, and no
      // way for the operator to tell whether setup completed (#2460).
      setFinishError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinishing(false);
    }
  };

  const reopenWizard = () => {
    window.dispatchEvent(new CustomEvent('servicebay:open-wizard'));
  };

  const isTerminal = job ? TERMINAL_PHASES.includes(job.phase) : false;

  if (!ready) {
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
        {finishError && (
          <div role="alert" className="p-3 rounded-card border border-status-fail/20 bg-status-fail/10 text-sm text-status-fail">
            Couldn&apos;t finish setup: {finishError}. Setup is still pending — try Finish again.
          </div>
        )}

        <StackInstallProgress controller={controller} />

        {isTerminal && (
          <StackInstallSummary
            controller={controller}
            doneFooter={
              <>
                <DnsPanel job={job} />
                <SelfTestPanel job={job} />
              </>
            }
          />
        )}
      </div>
    </div>
  );
}
