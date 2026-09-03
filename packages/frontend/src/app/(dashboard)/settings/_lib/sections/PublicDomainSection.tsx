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
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { fetchSystemMode, checkMigrationPreflight, migrateToPublicDomain, TypedFetchError } from '@servicebay/api-client';

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
  // Holds the latest fetchPreflight so the self-scheduling setTimeout can
  // recurse without referencing the callback before it is declared.
  const fetchPreflightRef = useRef<(domain: string) => void>(() => undefined);

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchSystemMode();
        const next = data as ModeInfo;
        setInfo(next);
        if (next.mode === 'public') {
          setPhase('public');
          setPendingDomain(next.publicDomain ?? '');
        } else {
          setPhase('idle');
        }
      } catch (e) {
        // Ignore errors on load
      }
    })();
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
      const data = await checkMigrationPreflight(domain);
      setPreflight(data);
      if (data.ready) {
        setPhase('confirm');
        stopPolling();
        return;
      }
    } catch (e) {
      const message = e instanceof TypedFetchError
        ? e.message
        : e instanceof Error ? e.message : String(e);
      addToast('error', 'Pre-flight check failed', message);
    }
    // Schedule next tick. The phase check inside the closure guards
    // against firing after the operator backs out.
    pollRef.current = setTimeout(() => {
      fetchPreflightRef.current(domain);
    }, PREFLIGHT_POLL_MS);
  }, [addToast, stopPolling]);

  useEffect(() => {
    fetchPreflightRef.current = fetchPreflight;
  }, [fetchPreflight]);

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
      const data = await migrateToPublicDomain(trimmed, dryRun);
      setResult(data);
      setPhase('done');
      const okSteps = data.stepResults.filter(s => s.ok).length;
      const total = data.stepResults.length;
      addToast(
        dryRun ? 'info' : data.errors.length === 0 ? 'success' : 'warning',
        dryRun ? 'Dry-run complete' : 'Migration applied',
        dryRun
          ? `${total} step${total === 1 ? '' : 's'} would run.`
          : `${okSteps}/${total} step${total === 1 ? '' : 's'} succeeded. See below for details.`,
      );
      if (!dryRun && data.errors.length === 0) {
        // Refresh the mode badge so the section header flips to `public`.
        try {
          const modeRes = await fetchSystemMode();
          setInfo(modeRes as ModeInfo);
        } catch (e) {
          // Ignore mode refresh errors
        }
      }
    } catch (e) {
      const message = e instanceof TypedFetchError
        ? e.message
        : e instanceof Error ? e.message : String(e);
      addToast('error', 'Request failed', message);
      setPhase('confirm');
    } finally {
      setMigrating(false);
    }
  }, [pendingDomain, addToast]);

  if (phase === 'loading' || !info) {
    return (
      <p className="text-sm text-text-subtle">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading mode…
      </p>
    );
  }

  const isLan = info.mode === 'lan';
  const Icon = isLan ? Home : Globe;

  return (
    <>
      <PublicDomainModeBanner isLan={isLan} Icon={Icon} info={info} />
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
    </>
  );
}

/** Compact in-body mode banner (#2109). Not a bordered box-in-box — the
 *  disclosure header already carries the "Public domain" title; this conveys
 *  the live LAN-vs-public state. */
function PublicDomainModeBanner({isLan, Icon, info}: {isLan: boolean; Icon: LucideIcon; info: ModeInfo}) {
  return (
    <div className={`flex items-start gap-3 rounded-card p-3 ${isLan ? 'bg-status-warn/5 border border-border' : 'bg-status-ok/5 border border-border'}`}>
      <Icon size={18} className={`shrink-0 mt-0.5 ${isLan ? 'text-status-warn' : 'text-status-ok'}`} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text">
          {isLan ? 'Internal-only mode' : 'Public-domain mode'}
        </p>
        <p className="text-xs text-text-subtle">
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
    <div className="space-y-4">
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
        <div className="flex items-center gap-2 text-sm text-text-muted">
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
    <div className="space-y-3 text-sm text-text-muted">
      <p>
        Public domain: <span className="font-mono">{info.publicDomain}</span>.
        ServiceBay is serving HTTPS via Let&apos;s Encrypt + Authelia SSO.
      </p>
      <p className="text-xs text-text-subtle">
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
      <p className="text-sm text-text-muted">
        Add a public domain to enable HTTPS, external access, and SSO over a real hostname.
        Internal URLs (<span className="font-mono">{`vault.${lanDomain}`}</span>, …) will keep working as a soft-handoff after migration.
      </p>
      <div className="flex gap-2">
        <Input
          type="text"
          value={pendingDomain}
          onChange={(e) => setPendingDomain(e.target.value)}
          placeholder="example.com"
          className="flex-1 p-2 border border-border bg-surface rounded text-sm"
          autoComplete="off"
        />
        <Button
          onClick={onCheckReadiness}
          disabled={!pendingDomain.trim()}
        >
          Check readiness
        </Button>
      </div>
      <ul className="text-xs text-text-subtle space-y-1 list-disc list-inside">
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
        <p className="text-sm text-text-muted">
          Checking readiness for <span className="font-mono">{publicDomain}</span>…
        </p>
        <div className="flex gap-2">
          <Button
            onClick={onRefresh}
            variant="ghost"
            size="sm"
            type="button"
          >
            <RefreshCw size={12} /> Refresh
          </Button>
          <Button
            onClick={onCancel}
            variant="ghost"
            size="sm"
            type="button"
          >
            Cancel
          </Button>
        </div>
      </div>
      <PreflightChecklist preflight={preflight} />
      {preflight && !preflight.ready && (
        <p className="text-xs text-text-subtle">
          Fix the failing checks (DNS A record at your registrar, port-forward in your router), then click Refresh.
        </p>
      )}
    </div>
  );
}

function PreflightChecklist({ preflight }: { preflight: PreflightStatus | null }) {
  if (!preflight) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-subtle">
        <Loader2 className="w-4 h-4 animate-spin" /> Running pre-flight…
      </div>
    );
  }
  return (
    <ul className="space-y-1 text-sm">
      {preflight.checks.map(c => (
        <li key={c.id} className="flex items-start gap-2">
          {c.status === 'pass' ? (
            <CheckCircle2 className="w-4 h-4 text-status-ok mt-0.5 flex-shrink-0" />
          ) : c.status === 'fail' ? (
            <XCircle className="w-4 h-4 text-status-fail mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-status-warn mt-0.5 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-medium text-text">{c.label}</div>
            <div className="text-xs text-text-subtle break-words">{c.detail}</div>
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
      <div className="p-3 bg-status-warn/5 border border-border rounded text-xs text-status-warn">
        <strong>Heads up:</strong> all currently logged-in users (including you) will need to log in again once the migration completes — the Authelia cookie domain flips from your LAN root to <span className="font-mono">{publicDomain}</span>.
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={onMigrate}
          disabled={migrating}
          variant="primary"
        >
          {migrating ? <Loader2 size={14} className="animate-spin" /> : null}
          Migrate to {publicDomain}
        </Button>
        <Button
          onClick={onDryRun}
          disabled={migrating}
          variant="secondary"
        >
          Dry-run first
        </Button>
        <Button
          onClick={onBack}
          disabled={migrating}
          variant="ghost"
        >
          Back
        </Button>
      </div>
    </div>
  );
}

function ResultStatusBox({ result }: { result: MigrationResult }) {
  const ok = result.errors.length === 0;
  const isDry = !result.applied;
  return (
    <div className={`p-3 rounded text-sm ${ok ? 'bg-status-ok/5 text-status-ok border border-border' : 'bg-status-fail/5 text-status-fail border border-border'}`}>
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
      <summary className="cursor-pointer text-text-muted hover:text-text">
        Show step-by-step ({result.stepResults.length})
      </summary>
      <ol className="mt-2 space-y-1 list-decimal list-inside text-text-subtle">
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
        <Button
          onClick={onMigrateAgain}
          variant="primary"
        >
          Apply for real
        </Button>
      ) : ok ? (
        <a
          href={`https://${result.plan.publicDomain}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-strong text-on-accent text-sm font-medium rounded"
        >
          <ExternalLink size={14} /> Open {result.plan.publicDomain}
        </a>
      ) : (
        <Button
          onClick={onMigrateAgain}
          variant="primary"
        >
          Retry failed steps
        </Button>
      )}
      <Button
        onClick={onReset}
        variant="ghost"
      >
        {ok ? 'Done' : 'Close'}
      </Button>
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
        <ul className="text-xs text-status-warn space-y-1 list-disc list-inside">
          {result.plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <ResultStepDetails result={result} />
      <ResultActions result={result} onMigrateAgain={onMigrateAgain} onReset={onReset} />
    </div>
  );
}
