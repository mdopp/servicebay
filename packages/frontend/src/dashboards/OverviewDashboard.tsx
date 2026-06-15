'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Box, Network, Activity, Terminal, Settings, ArrowRight, AlertCircle, CheckCircle2, Wrench } from 'lucide-react';
import { useDigitalTwinContext } from '@/providers/DigitalTwinProvider';
import InstallProgressCard from '@/components/InstallProgressCard';
import { useCoreHealth } from '@/hooks/useCoreHealth';

/**
 * Latest persisted diagnose breakdown for the Home card (#1873).
 *
 * Reads GET /api/health/checks — the SAME endpoint HealthDashboard already
 * polls — which returns the enriched check rows including the synthetic
 * `diagnose:*` probe rows persisted by the daily self-diagnose run
 * (getDiagnoseChecksEnriched). This is a pure read of the LAST persisted
 * results: it does NOT trigger a diagnose run (no POST /api/system/diagnose).
 * A fresh box with no persisted results returns zero diagnose rows → the
 * card renders "Not run yet" / neutral.
 */
export interface DiagnoseBreakdown {
  healthy: number;
  warning: number;
  failure: number;
  unknown: number;
  total: number;
  loaded: boolean;
}

interface EnrichedCheckRow {
  id: string;
  status?: string;
  diagnose?: { status?: string };
}

/** Map a diagnose row to one of the four buckets. The four-way status lives
 *  on `diagnose.status` (ok/warn/fail/info); the row-level `status` only
 *  carries the folded binary ok/fail, so we prefer the diagnose field and
 *  fall back to it when absent. Per #1873: ok→healthy, warn→warning,
 *  fail→failure, info/none/unknown→unknown. */
function bucketForDiagnoseRow(row: EnrichedCheckRow): keyof Omit<DiagnoseBreakdown, 'total' | 'loaded'> {
  const status = row.diagnose?.status ?? row.status;
  if (status === 'ok') return 'healthy';
  if (status === 'warn') return 'warning';
  if (status === 'fail') return 'failure';
  return 'unknown';
}

export function summarizeDiagnoseRows(rows: EnrichedCheckRow[]): Omit<DiagnoseBreakdown, 'loaded'> {
  const breakdown = { healthy: 0, warning: 0, failure: 0, unknown: 0, total: 0 };
  for (const row of rows) {
    if (!row.id?.startsWith('diagnose:')) continue;
    breakdown[bucketForDiagnoseRow(row)] += 1;
    breakdown.total += 1;
  }
  return breakdown;
}

function useDiagnoseOverview(): DiagnoseBreakdown {
  const [breakdown, setBreakdown] = useState<DiagnoseBreakdown>({
    healthy: 0,
    warning: 0,
    failure: 0,
    unknown: 0,
    total: 0,
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/health/checks');
        if (!res.ok) return;
        const rows = (await res.json()) as EnrichedCheckRow[];
        if (cancelled) return;
        setBreakdown({ ...summarizeDiagnoseRows(rows), loaded: true });
      } catch (error) {
        // Background read — keep the card neutral on failure rather than
        // surfacing a transient fetch blip as a diagnose state.
        console.error('[OverviewDashboard] Failed to read diagnose results', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return breakdown;
}

/** Card metric/description/tone from the persisted diagnose breakdown.
 *  Tone mirrors the other OverviewCards (worst status wins):
 *  any failure → bad, else any warning → warn, else a run with no issues →
 *  good, else (never run) → neutral. */
export function diagnoseCardView(b: DiagnoseBreakdown): {
  metric: string;
  description: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
} {
  if (!b.loaded) return { metric: '…', description: 'Reading diagnose status…', tone: 'neutral' };
  if (b.total === 0) {
    return { metric: 'Not run yet', description: 'Run probes, view system logs, inspect raw containers', tone: 'neutral' };
  }
  const metric = `${b.healthy} healthy · ${b.warning} warning · ${b.failure} failure`;
  if (b.failure > 0) {
    return { metric, description: `${b.failure} probe${b.failure === 1 ? '' : 's'} failing`, tone: 'bad' };
  }
  if (b.warning > 0) {
    return { metric, description: `${b.warning} probe${b.warning === 1 ? '' : 's'} warning`, tone: 'warn' };
  }
  return { metric, description: 'All probes healthy', tone: 'good' };
}

/**
 * Home / Overview dashboard (#803).
 *
 * The first thing an operator sees when they open ServiceBay. The
 * design rule from UX_DECISIONS.md "Primary sidebar is a user-task
 * list" applies here too: this page answers household questions
 * (*"is anything broken?"*, *"where do I go next?"*) instead of
 * dumping raw infrastructure counts.
 *
 * Backed entirely by the existing DigitalTwinProvider snapshot — no
 * new endpoints, no new polling loops. When the twin is still syncing
 * we show the skeleton state and the cards self-update once the
 * snapshot lands.
 *
 * Cards link out to the existing dashboards rather than embedding
 * full detail, so this stays a navigation surface, not a fourth
 * place to look for the same data.
 */
export default function OverviewDashboard() {
  const { data, isConnected } = useDigitalTwinContext();
  // Truthy `data` is the readiness signal — DigitalTwinProvider holds
  // the snapshot in a useState, so on a fast machine the first render
  // already sees data and the "Reading status…" headline never shows.
  // On reconnect after a drop, `data` stays populated from the last
  // snapshot; `isConnected=false` is what we surface to the user.
  const hasFirstSnapshot = data !== null && data !== undefined;

  const firstNode = data?.nodes ? Object.values(data.nodes)[0] : undefined;
  const services = firstNode?.services || [];
  const managedServices = services.filter(s => s.activeState === 'active' || s.activeState === 'failed' || s.activeState === 'inactive');
  const activeCount = managedServices.filter(s => s.activeState === 'active').length;
  const failedCount = managedServices.filter(s => s.activeState === 'failed').length;
  const totalCount = managedServices.length;

  const gatewayUp = data?.gateway?.upstreamStatus === 'up';

  // Same signal the CoreHealthBanner uses. The twin only carries systemd
  // `activeState`, so a core service that's "active" but crash-looping
  // (e.g. authelia failing its LDAP bind) counted as healthy here — which
  // contradicted the banner's "Core stack unhealthy". Reading core-health
  // directly keeps the headline and the banner in agreement.
  const { unhealthy: coreUnhealthy } = useCoreHealth();

  // Latest persisted diagnose breakdown (#1873) — read-only, no run kicked off.
  const diagnose = useDiagnoseOverview();
  const diagnoseView = diagnoseCardView(diagnose);

  const healthHeadline = (() => {
    if (!hasFirstSnapshot) return { tone: 'neutral' as const, text: 'Reading status…' };
    if (coreUnhealthy) return { tone: 'bad' as const, text: 'Core services need attention' };
    if (failedCount > 0) return { tone: 'bad' as const, text: `${failedCount} service${failedCount === 1 ? '' : 's'} need${failedCount === 1 ? 's' : ''} attention` };
    if (totalCount === 0) return { tone: 'neutral' as const, text: 'No services installed yet' };
    if (!gatewayUp) return { tone: 'warn' as const, text: 'Internet gateway is unreachable' };
    return { tone: 'good' as const, text: 'Everything looks healthy' };
  })();

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Home</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {data?.serverName || firstNode?.resources?.os?.hostname || 'ServiceBay'}
            {!isConnected && hasFirstSnapshot && (
              <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">· reconnecting…</span>
            )}
          </p>
        </header>

        {/* Live install monitor — only renders while an install is
            running, so every web client sees the same progress the
            sb monitor shows (#A). */}
        <InstallProgressCard />

        {/* Headline status — the single sentence that answers "is everything OK?" */}
        <HealthHeadline tone={healthHeadline.tone} text={healthHeadline.text} />

        {/* Setup wizard CTA banner shown when nothing has been installed yet (#902 followup) */}
        {hasFirstSnapshot && totalCount === 0 && (
          <div className="rounded-2xl p-6 premium-hover-card flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Wrench className="text-blue-500 shrink-0" size={22} />
                Welcome to ServiceBay!
              </h2>
              <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 font-medium max-w-xl leading-relaxed">
                You haven&apos;t installed any services yet. Start the setup wizard to configure your network, OIDC identity pool, SMTP notifications, and deploy your first home server stacks.
              </p>
            </div>
            <Link
              href="/setup"
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-lg shadow-blue-500/20 transition-all flex items-center gap-2 group shrink-0"
            >
              Start Setup Wizard
              <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>
        )}

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <OverviewCard
            href="/services"
            title="Services"
            metric={hasFirstSnapshot ? `${activeCount} of ${totalCount} running` : '…'}
            description={
              failedCount > 0
                ? `${failedCount} need attention`
                : totalCount === 0
                  ? 'No services installed yet'
                  : activeCount === totalCount
                    ? 'All services are running'
                    : `${totalCount - activeCount} service${totalCount - activeCount === 1 ? '' : 's'} stopped`
            }
            icon={Box}
            tone={failedCount > 0 ? 'bad' : totalCount === 0 ? 'neutral' : activeCount === totalCount ? 'good' : 'warn'}
          />
          <OverviewCard
            href="/network"
            title="Network Map"
            metric={gatewayUp ? 'Internet OK' : hasFirstSnapshot ? 'Gateway down' : '…'}
            description={
              gatewayUp
                ? 'See how services talk to each other'
                : hasFirstSnapshot
                  ? 'Upstream connection is unreachable'
                  : 'Reading gateway status…'
            }
            icon={Network}
            tone={gatewayUp ? 'good' : hasFirstSnapshot ? 'warn' : 'neutral'}
          />
          <OverviewCard
            href="/health"
            title="Diagnostics"
            metric={diagnoseView.metric}
            description={diagnoseView.description}
            icon={Activity}
            tone={diagnoseView.tone}
          />
          <OverviewCard
            href="/terminal"
            title="SSH Terminal"
            metric="Console"
            description="A shell on the host for expert tasks"
            icon={Terminal}
            tone="neutral"
          />
        </section>

        <footer className="pt-4 border-t border-gray-200 dark:border-gray-800 flex justify-end">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <Settings size={14} /> Settings
          </Link>
        </footer>
      </div>
    </div>
  );
}

function HealthHeadline({ tone, text }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }) {
  const toneClasses: Record<typeof tone, string> = {
    good: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50 text-emerald-800 dark:text-emerald-300',
    warn: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50 text-amber-800 dark:text-amber-300',
    bad: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50 text-red-800 dark:text-red-300',
    neutral: 'bg-gray-50 dark:bg-gray-900/40 border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300',
  };
  const Icon = tone === 'bad' || tone === 'warn' ? AlertCircle : CheckCircle2;
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-all duration-300 ${toneClasses[tone]}`}>
      <Icon size={20} className="shrink-0" />
      <span className="text-sm font-semibold tracking-wide">{text}</span>
    </div>
  );
}

interface OverviewCardProps {
  href: string;
  title: string;
  metric: string;
  description: string;
  icon: typeof Box;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

function OverviewCard({ href, title, metric, description, icon: Icon, tone }: OverviewCardProps) {
  const accentClasses: Record<typeof tone, string> = {
    good: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-red-600 dark:text-red-400',
    neutral: 'text-blue-600 dark:text-blue-400',
  };
  return (
    <Link
      href={href}
      className="group block rounded-xl p-5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 premium-hover-card"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <Icon size={20} className={accentClasses[tone]} />
        <ArrowRight size={16} className="text-gray-400 dark:text-gray-600 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors duration-300" />
      </div>
      <h2 className="font-bold text-gray-900 dark:text-gray-100 tracking-wide text-base">{title}</h2>
      <p className={`text-sm font-semibold mt-1 ${accentClasses[tone]}`}>{metric}</p>
      <p className="text-xs text-gray-600 dark:text-gray-300 mt-2 font-medium leading-relaxed">{description}</p>
    </Link>
  );
}
