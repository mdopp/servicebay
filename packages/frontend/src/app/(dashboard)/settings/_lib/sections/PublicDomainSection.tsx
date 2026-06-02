'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Home,
  Loader2,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface ModeInfo {
  mode: 'lan' | 'public';
  activeDomain: string;
  publicDomain: string | null;
  lanDomain: string | null;
}

interface PreflightCheck {
  id: 'dns' | 'http01' | 'port-forward';
  label: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
}

interface PreflightStatus {
  publicDomain: string;
  ready: boolean;
  checks: PreflightCheck[];
}

interface MigrationStep {
  kind: 'npm-dual-server-name' | 'authelia-config' | 'cert-request';
  domain?: string;
  node?: string;
  hostId?: number;
  skipped?: boolean;
}

interface MigrationResult {
  plan: { publicDomain: string; lanRoot: string; warnings: string[]; steps: MigrationStep[] };
  applied: boolean;
  errors: { step: string; detail: string; target?: string }[];
  stepResults: { ok: boolean; error?: string }[];
}

type Phase = 'loading' | 'idle' | 'preflight' | 'confirm' | 'migrating' | 'done' | 'public';

const PREFLIGHT_POLL_MS = 5000;

/**
 * Settings section that drives the LAN→Public migration (#265).
 *
 * State machine:
 *
 *   loading → idle (lan mode, no pending domain)
 *           → public (already on a public domain)
 *
 *   idle → preflight (operator entered a domain and clicked "Check
 *          readiness"; we poll GET /preflight every 5 s)
 *
 *   preflight → confirm (all three pre-flight checks green; operator
 *          can dry-run or migrate)
 *
 *   confirm → migrating → done
 *
 * The orchestrator's per-step output is surfaced verbatim in `done`
 * so the operator can see which steps ran, which were skipped, and
 * which errored. Re-clicking "Migrate" after a partial failure
 * re-runs the orchestrator (idempotent per the design).
 */
export default function PublicDomainSection() {
  const { addToast } = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [pendingDomain, setPendingDomain] = useState('');
  const [preflight, setPreflight] = useState<PreflightStatus | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);

  // Track the polling timer so we can stop it cleanly when the phase
  // moves off `preflight` (operator cancelled, migration started, etc.).
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/system/mode')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data) return;
        const next = data as ModeInfo;
        setInfo(next);
        if (next.mode === 'public') {
          setPhase('public');
          setPendingDomain(next.publicDomain ?? '');
        } else {
          setPhase('idle');
        }
      })
      .catch(() => undefined);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  /** Single pre-flight call. Schedules the next tick on success. */
  const fetchPreflight = useCallback(async (domain: string) => {
    try {
      const res = await fetch(`/api/system/reverse-proxy/preflight?publicDomain=${encodeURIComponent(domain)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast('error', 'Pre-flight check failed', data.error || `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as PreflightStatus;
      setPreflight(data);
      if (data.ready) {
        setPhase('confirm');
        stopPolling();
        return;
      }
    } catch (e) {
      addToast('error', 'Pre-flight check failed', e instanceof Error ? e.message : String(e));
    }
    // Schedule next tick. The phase check inside the closure guards
    // against firing after the operator backs out.
    pollRef.current = setTimeout(() => {
      void fetchPreflight(domain);
    }, PREFLIGHT_POLL_MS);
  }, [addToast, stopPolling]);

  const startPreflight = useCallback(() => {
    const trimmed = pendingDomain.trim();
    if (!trimmed) {
      addToast('error', 'Domain required', 'Enter the public domain you want to migrate to.');
      return;
    }
    setPreflight(null);
    setPhase('preflight');
    void fetchPreflight(trimmed);
  }, [pendingDomain, fetchPreflight, addToast]);

  const cancelPreflight = useCallback(() => {
    stopPolling();
    setPreflight(null);
    setPhase('idle');
  }, [stopPolling]);

  const runMigration = useCallback(async (dryRun: boolean) => {
    const trimmed = pendingDomain.trim();
    if (!trimmed) return;
    setMigrating(true);
    setPhase('migrating');
    try {
      const res = await fetch('/api/system/reverse-proxy/migrate-to-public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicDomain: trimmed, dryRun }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', dryRun ? 'Dry-run failed' : 'Migration failed', data.error || `HTTP ${res.status}`);
        setPhase('confirm');
        return;
      }
      setResult(data as MigrationResult);
      setPhase('done');
      const okSteps = (data as MigrationResult).stepResults.filter(s => s.ok).length;
      const total = (data as MigrationResult).stepResults.length;
      addToast(
        dryRun ? 'info' : (data as MigrationResult).errors.length === 0 ? 'success' : 'warning',
        dryRun ? 'Dry-run complete' : 'Migration applied',
        dryRun
          ? `${total} step${total === 1 ? '' : 's'} would run.`
          : `${okSteps}/${total} step${total === 1 ? '' : 's'} succeeded. See below for details.`,
      );
      if (!dryRun && (data as MigrationResult).errors.length === 0) {
        // Refresh the mode badge so the section header flips to `public`.
        const modeRes = await fetch('/api/system/mode').then(r => r.json()).catch(() => null);
        if (modeRes) setInfo(modeRes as ModeInfo);
      }
    } catch (e) {
      addToast('error', 'Request failed', e instanceof Error ? e.message : String(e));
      setPhase('confirm');
    } finally {
      setMigrating(false);
    }
  }, [pendingDomain, addToast]);

  if (phase === 'loading' || !info) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading mode…
      </div>
    );
  }

  const isLan = info.mode === 'lan';
  const Icon = isLan ? Home : Globe;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <PublicDomainHeader isLan={isLan} Icon={Icon} info={info} />
      <PublicDomainBody
        phase={phase}
        info={info}
        preflight={preflight}
        pendingDomain={pendingDomain}
        setPendingDomain={setPendingDomain}
        migrating={migrating}
        result={result}
        startPreflight={startPreflight}
        cancelPreflight={cancelPreflight}
        fetchPreflight={fetchPreflight}
        stopPolling={stopPolling}
        runMigration={runMigration}
        setPhase={setPhase}
        setResult={setResult}
        setPreflight={setPreflight}
      />
    </div>
  );
}

function PublicDomainHeader({isLan, Icon, info}: {isLan: boolean; Icon: LucideIcon; info: ModeInfo}) {
  return (
    <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${isLan ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'}`}>
        <Icon size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-gray-900 dark:text-white">
          {isLan ? 'Internal-only mode' : 'Public-domain mode'}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {isLan
            ? `Services live on <sub>.${info.activeDomain} via AdGuard DNS rewrites. No HTTPS, no external access.`
            : `Services reachable as <sub>.${info.publicDomain} with Let's Encrypt SSL + external access. Internal URLs (<sub>.${info.lanDomain ?? 'home.arpa'}) keep working as a soft-handoff.`}
        </p>
      </div>
    </div>
  );
}

function PublicDomainBody({
  phase, info, preflight, pendingDomain, setPendingDomain, migrating, result,
  startPreflight, cancelPreflight, fetchPreflight, stopPolling, runMigration, setPhase, setResult, setPreflight,
}: {
  phase: Phase; info: ModeInfo; preflight: PreflightStatus | null; pendingDomain: string;
  setPendingDomain: (v: string) => void; migrating: boolean; result: MigrationResult | null;
  startPreflight: () => void; cancelPreflight: () => void; fetchPreflight: (domain: string) => Promise<void>;
  stopPolling: () => void; runMigration: (dryRun: boolean) => Promise<void>; setPhase: (p: Phase) => void;
  setResult: (r: MigrationResult | null) => void; setPreflight: (p: PreflightStatus | null) => void;
}) {
  return (
    <div className="p-6 space-y-4">
      {phase === 'public' && info.publicDomain && <PublicModeBody info={info} />}
      {phase === 'idle' && (
        <IdleForm
          lanDomain={info.activeDomain}
          pendingDomain={pendingDomain}
          setPendingDomain={setPendingDomain}
          onCheckReadiness={startPreflight}
        />
      )}
      {phase === 'preflight' && (
        <PreflightPanel
          publicDomain={pendingDomain.trim()}
          preflight={preflight}
          onCancel={cancelPreflight}
          onRefresh={() => {
            stopPolling();
            void fetchPreflight(pendingDomain.trim());
          }}
        />
      )}
      {phase === 'confirm' && preflight && (
        <ConfirmPanel
          publicDomain={pendingDomain.trim()}
          preflight={preflight}
          migrating={migrating}
          onDryRun={() => runMigration(true)}
          onMigrate={() => runMigration(false)}
          onBack={() => setPhase('preflight')}
        />
      )}
      {phase === 'migrating' && (
        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Loader2 className="w-4 h-4 animate-spin" />
          Migrating… NPM hosts, Authelia, and cert request can take 30–120 s combined.
        </div>
      )}
      {phase === 'done' && result && (
        <ResultPanel
          result={result}
          onMigrateAgain={() => runMigration(false)}
          onReset={() => {
            setResult(null);
            setPreflight(null);
            setPhase(result.applied && result.errors.length === 0 ? 'public' : 'idle');
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function PublicModeBody({ info }: { info: ModeInfo }) {
  return (
    <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
      <p>
        Public domain: <span className="font-mono">{info.publicDomain}</span>.
        ServiceBay is serving HTTPS via Let&apos;s Encrypt + Authelia SSO.
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Internal LAN URLs (<span className="font-mono">{`<sub>.${info.lanDomain ?? 'home.arpa'}`}</span>) keep working as a soft-handoff.
        Removing them entirely is a separate cleanup action, not surfaced here yet.
      </p>
    </div>
  );
}

function IdleForm({
  lanDomain,
  pendingDomain,
  setPendingDomain,
  onCheckReadiness,
}: {
  lanDomain: string;
  pendingDomain: string;
  setPendingDomain: (v: string) => void;
  onCheckReadiness: () => void;
}) {
  return (
    <>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Add a public domain to enable HTTPS, external access, and SSO over a real hostname.
        Internal URLs (<span className="font-mono">{`vault.${lanDomain}`}</span>, …) will keep working as a soft-handoff after migration.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={pendingDomain}
          onChange={(e) => setPendingDomain(e.target.value)}
          placeholder="example.com"
          className="flex-1 p-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 rounded text-sm"
          autoComplete="off"
        />
        <button
          onClick={onCheckReadiness}
          disabled={!pendingDomain.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded disabled:opacity-50"
        >
          Check readiness
        </button>
      </div>
      <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1 list-disc list-inside">
        <li>The pre-flight checks DNS, port 80, and your router port-forward before anything is changed.</li>
        <li>ServiceBay requests Let&apos;s Encrypt certs for each service after the migration.</li>
        <li>Active SSO sessions will need to log in again once the Authelia cookie domain flips.</li>
      </ul>
    </>
  );
}

function PreflightPanel({
  publicDomain,
  preflight,
  onCancel,
  onRefresh,
}: {
  publicDomain: string;
  preflight: PreflightStatus | null;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          Checking readiness for <span className="font-mono">{publicDomain}</span>…
        </p>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            type="button"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            onClick={onCancel}
            className="px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
      <PreflightChecklist preflight={preflight} />
      {preflight && !preflight.ready && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Fix the failing checks (DNS A record at your registrar, port-forward in your router), then click Refresh.
        </p>
      )}
    </div>
  );
}

function PreflightChecklist({ preflight }: { preflight: PreflightStatus | null }) {
  if (!preflight) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Running pre-flight…
      </div>
    );
  }
  return (
    <ul className="space-y-1 text-sm">
      {preflight.checks.map(c => (
        <li key={c.id} className="flex items-start gap-2">
          {c.status === 'pass' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
          ) : c.status === 'fail' ? (
            <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-medium text-gray-800 dark:text-gray-200">{c.label}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 break-words">{c.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ConfirmPanel({
  publicDomain,
  preflight,
  migrating,
  onDryRun,
  onMigrate,
  onBack,
}: {
  publicDomain: string;
  preflight: PreflightStatus;
  migrating: boolean;
  onDryRun: () => void;
  onMigrate: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <PreflightChecklist preflight={preflight} />
      <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-200">
        <strong>Heads up:</strong> all currently logged-in users (including you) will need to log in again once the migration completes — the Authelia cookie domain flips from your LAN root to <span className="font-mono">{publicDomain}</span>.
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onMigrate}
          disabled={migrating}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded disabled:opacity-50"
        >
          {migrating ? <Loader2 size={14} className="animate-spin" /> : null}
          Migrate to {publicDomain}
        </button>
        <button
          onClick={onDryRun}
          disabled={migrating}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 text-sm font-medium rounded disabled:opacity-50"
        >
          Dry-run first
        </button>
        <button
          onClick={onBack}
          disabled={migrating}
          className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function ResultStatusBox({ result }: { result: MigrationResult }) {
  const ok = result.errors.length === 0;
  const isDry = !result.applied;
  return (
    <div className={`p-3 rounded text-sm ${ok ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800' : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800'}`}>
      {isDry
        ? `Dry-run for ${result.plan.publicDomain}: ${result.stepResults.length} step${result.stepResults.length === 1 ? '' : 's'} would run.`
        : ok
          ? `Migration to ${result.plan.publicDomain} complete.`
          : `Migration to ${result.plan.publicDomain} finished with ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}; re-run to retry the failed steps.`}
    </div>
  );
}

function ResultStepDetails({ result }: { result: MigrationResult }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100">
        Show step-by-step ({result.stepResults.length})
      </summary>
      <ol className="mt-2 space-y-1 list-decimal list-inside text-gray-600 dark:text-gray-400">
        {result.plan.steps.map((step, i) => {
          const r = result.stepResults[i];
          const skipped = step.skipped === true;
          return (
            <li key={`${step.kind}:${i}`} className="break-words">
              <span className="font-mono">{step.kind}</span>{' '}
              {step.domain ? <span className="font-mono">{step.domain}</span> : null}
              {step.node ? <span> on <span className="font-mono">{step.node}</span></span> : null}
              {' — '}
              {!r ? '(not run)' : r.ok ? (skipped ? 'skipped (already done)' : 'ok') : `failed: ${r.error}`}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function ResultActions({
  result,
  onMigrateAgain,
  onReset,
}: {
  result: MigrationResult;
  onMigrateAgain: () => void;
  onReset: () => void;
}) {
  const ok = result.errors.length === 0;
  const isDry = !result.applied;
  return (
    <div className="flex flex-wrap gap-2">
      {isDry ? (
        <button
          onClick={onMigrateAgain}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded"
        >
          Apply for real
        </button>
      ) : ok ? (
        <a
          href={`https://${result.plan.publicDomain}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded"
        >
          <ExternalLink size={14} /> Open {result.plan.publicDomain}
        </a>
      ) : (
        <button
          onClick={onMigrateAgain}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded"
        >
          Retry failed steps
        </button>
      )}
      <button
        onClick={onReset}
        className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
      >
        {ok ? 'Done' : 'Close'}
      </button>
    </div>
  );
}

function ResultPanel({
  result,
  onMigrateAgain,
  onReset,
}: {
  result: MigrationResult;
  onMigrateAgain: () => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-3">
      <ResultStatusBox result={result} />
      {result.plan.warnings.length > 0 && (
        <ul className="text-xs text-amber-700 dark:text-amber-300 space-y-1 list-disc list-inside">
          {result.plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <ResultStepDetails result={result} />
      <ResultActions result={result} onMigrateAgain={onMigrateAgain} onReset={onReset} />
    </div>
  );
}
