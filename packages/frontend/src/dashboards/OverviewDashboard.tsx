'use client';

import Link from 'next/link';
import { Box, Network, Activity, Terminal, Settings, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useDigitalTwinContext } from '@/providers/DigitalTwinProvider';

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

  const healthHeadline = (() => {
    if (!hasFirstSnapshot) return { tone: 'neutral' as const, text: 'Reading status…' };
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

        {/* Headline status — the single sentence that answers "is everything OK?" */}
        <HealthHeadline tone={healthHeadline.tone} text={healthHeadline.text} />

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
                  : 'All services are running'
            }
            icon={Box}
            tone={failedCount > 0 ? 'bad' : totalCount === 0 ? 'neutral' : 'good'}
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
            metric="Self-test"
            description="Run probes, view system logs, inspect raw containers"
            icon={Activity}
            tone="neutral"
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
    good: 'bg-emerald-50/80 dark:bg-emerald-950/20 border-emerald-200/50 dark:border-emerald-900/50 text-emerald-800 dark:text-emerald-300 backdrop-blur-md pulse-glow-emerald',
    warn: 'bg-amber-50/80 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-900/50 text-amber-800 dark:text-amber-300 backdrop-blur-md pulse-glow-amber',
    bad: 'bg-red-50/80 dark:bg-red-950/20 border-red-200/50 dark:border-red-900/50 text-red-800 dark:text-red-300 backdrop-blur-md pulse-glow-rose',
    neutral: 'bg-gray-50/80 dark:bg-gray-900/40 border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 backdrop-blur-md',
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
      className="group block rounded-xl p-5 glass-panel premium-hover-card"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <Icon size={20} className={accentClasses[tone]} />
        <ArrowRight size={16} className="text-gray-400 dark:text-gray-600 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors duration-300" />
      </div>
      <h2 className="font-bold text-gray-900 dark:text-gray-100 tracking-wide text-base">{title}</h2>
      <p className={`text-sm font-semibold mt-1 ${accentClasses[tone]}`}>{metric}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-medium leading-relaxed">{description}</p>
    </Link>
  );
}
