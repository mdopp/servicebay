'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useDigitalTwinContext } from '@/providers/DigitalTwinProvider';
import { useCoreHealth } from '@/hooks/useCoreHealth';
import { useImageUpdates, type ServiceImageUpdate } from '@/hooks/useImageUpdates';
import { useServiceActions } from '@/hooks/useServiceActions';
import ImageUpdatesPendingBanner from '@/components/ImageUpdatesPendingBanner';

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
 *  Tone mirrors the headline (worst status wins):
 *  any failure → bad, else any warning → warn, else a run with no issues →
 *  good, else (never run) → neutral. */
export function diagnoseCardView(b: DiagnoseBreakdown): {
  metric: string;
  description: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
} {
  if (!b.loaded) return { metric: '…', description: 'Reading diagnose status…', tone: 'neutral' };
  if (b.total === 0) {
    return { metric: 'Not run yet', description: 'No diagnostics have run on this box yet', tone: 'neutral' };
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
 * Home — the lean, status-led landing (IA redesign, spec §4.3 spirit).
 *
 * Restored from the old OverviewDashboard but lightened to answer ONE
 * question at a glance: *"is my box OK?"*. The old grid of pure-navigation
 * shortcut cards (Services / Network Map / Diagnostics / SSH Terminal) is
 * gone — that's all covered by the top nav now — and the install-progress
 * monitor stays where it was folded, on the Services list. What remains is
 * the value: the box-wide health headline + the latest persisted diagnose
 * breakdown.
 *
 * Backed entirely by the existing DigitalTwinProvider snapshot + the
 * read-only /api/health/checks endpoint — no new endpoints, no diagnose run
 * kicked off.
 */
export default function OverviewDashboard() {
  const { data, isConnected } = useDigitalTwinContext();
  // Truthy `data` is the readiness signal — DigitalTwinProvider holds
  // the snapshot in a useState, so on a fast machine the first render
  // already sees data and the "Reading status…" headline never shows.
  // On reconnect after a drop, `data` stays populated from the last
  // snapshot; `isConnected=false` is what we surface to the user.
  const hasFirstSnapshot = data !== null && data !== undefined;

  const firstNodeEntry = data?.nodes ? Object.entries(data.nodes)[0] : undefined;
  const firstNodeName = firstNodeEntry?.[0];
  const firstNode = firstNodeEntry?.[1];
  // Memoized so the update-action callback's dependency stays referentially
  // stable across renders (otherwise the `|| []` literal is a fresh array each time).
  const services = useMemo(() => firstNode?.services || [], [firstNode]);
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

  // Pending service-image updates — box status, so it belongs on Home too
  // (#1860). The banner's "Update now" re-deploys each listed service via the
  // same `update` action the Services list uses (pull latest image → restart).
  const { available: imageUpdates, refresh: refreshImageUpdates } = useImageUpdates();
  const { updateServiceImage, overlays: serviceActionOverlays } = useServiceActions({ onRefresh: refreshImageUpdates });

  // Resolve a bare service name from the image-update report to a minimal
  // action target (name + node) the `update` action needs. The Home twin
  // carries raw ServiceUnits keyed under the first node, so we look up the unit
  // and tag it with that node name.
  const handleUpdateAll = useCallback(async (updates: ServiceImageUpdate[]) => {
    for (const update of updates) {
      const bare = update.service.replace(/\.service$/, '');
      const unit = services.find(s => s.name.replace(/\.service$/, '') === bare);
      if (!unit) continue;
      const target = {
        id: unit.name,
        name: unit.name,
        displayName: unit.description || bare,
        nodeName: firstNodeName,
      } as unknown as ServiceViewModel;
      await updateServiceImage(target);
    }
    await refreshImageUpdates();
  }, [services, firstNodeName, updateServiceImage, refreshImageUpdates]);

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
      {serviceActionOverlays}
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

        {/* Headline status — the single sentence that answers "is everything OK?" */}
        <HealthHeadline tone={healthHeadline.tone} text={healthHeadline.text} />

        {/* Pending image updates — box status, actionable right here (#1860).
            Renders nothing when there are none. */}
        <ImageUpdatesPendingBanner updates={imageUpdates} onUpdate={handleUpdateAll} />

        {/* Box-wide at-a-glance: services running + latest diagnose breakdown. */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatCard
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
            tone={failedCount > 0 ? 'bad' : totalCount === 0 ? 'neutral' : activeCount === totalCount ? 'good' : 'warn'}
            href="/services"
          />
          <StatCard
            title="Diagnostics"
            metric={diagnoseView.metric}
            description={diagnoseView.description}
            icon={Activity}
            tone={diagnoseView.tone}
            href="/status"
          />
        </section>
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

interface StatCardProps {
  title: string;
  metric: string;
  description: string;
  icon?: typeof Activity;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  /** Where clicking the card navigates (#2067 — the Home cards used to be
   *  inert; the operator clicked them and nothing happened). When set, the
   *  card renders as a Next <Link> with a clear hover affordance. */
  href?: string;
}

function StatCard({ title, metric, description, icon: Icon, tone, href }: StatCardProps) {
  const accentClasses: Record<typeof tone, string> = {
    good: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-red-600 dark:text-red-400',
    neutral: 'text-blue-600 dark:text-blue-400',
  };
  const inner = (
    <>
      {Icon && (
        <div className="mb-3">
          <Icon size={20} className={accentClasses[tone]} />
        </div>
      )}
      <h2 className="font-bold text-gray-900 dark:text-gray-100 tracking-wide text-base">{title}</h2>
      <p className={`text-sm font-semibold mt-1 ${accentClasses[tone]}`}>{metric}</p>
      <p className="text-xs text-gray-600 dark:text-gray-300 mt-2 font-medium leading-relaxed">{description}</p>
    </>
  );
  const baseClasses = 'block rounded-xl p-5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800';
  if (href) {
    return (
      <Link
        href={href}
        className={`${baseClasses} cursor-pointer transition-all hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-md dark:hover:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={baseClasses}>{inner}</div>;
}
