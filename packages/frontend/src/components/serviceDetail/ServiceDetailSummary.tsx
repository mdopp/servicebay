'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  ExternalLink,
  RotateCw,
  ScrollText,
  ArrowRight,
  CheckCircle,
  AlertTriangle,
  XCircle,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { logger, type Check, type ServiceViewModel } from '@servicebay/api-client';
import type { RowStatus } from '@/components/HealthChecks';
import { useToast } from '@/providers/ToastProvider';
import { Card, StatusDot, type StatusState } from '@/components/ui';
import { useServiceHealth, overallHealth, serviceBaseName } from './serviceHealth';

const DOT_META: Record<RowStatus, { state: StatusState; label: string; text: string }> = {
  ok: { state: 'ok', label: 'Healthy', text: 'text-status-ok' },
  warn: { state: 'warn', label: 'Warning', text: 'text-status-warn' },
  fail: { state: 'fail', label: 'Failing', text: 'text-status-fail' },
  unknown: { state: 'unknown', label: 'Unknown', text: 'text-text-subtle' },
};

const CHECK_ICON: Record<RowStatus, typeof CheckCircle> = {
  ok: CheckCircle,
  warn: AlertTriangle,
  fail: XCircle,
  unknown: AlertCircle,
};

/** The primary clickable address for a service (first verified domain, else a
 *  host-port URL on the current host), or null when there's nothing to open. */
export function primaryServiceUrl(service: ServiceViewModel): string | null {
  const domain = service.verifiedDomains?.find(d => /\./.test(d.replace(/^https?:\/\//, '')));
  if (domain) return domain.startsWith('http') ? domain : `https://${domain}`;
  if (service.url) return service.url;
  const hostPort = service.ports?.find(p => p.host)?.host;
  if (hostPort) {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `http://${host}:${hostPort}`;
  }
  return null;
}

function formatUptime(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  if (h >= 24) return `up ${Math.floor(h / 24)}d`;
  if (h >= 1) return `up ${h}h`;
  return `up ${Math.max(1, Math.floor(seconds / 60))}m`;
}

/**
 * The ONE shared per-service detail summary (IA slice 1, #2029 / spec §4.2).
 *
 * Status + quick actions + a health roll-up + a link to the full Operate page.
 * Rendered everywhere a single service is selected — the Operate page header AND
 * the Network-map node sidebar (replacing the old bespoke, out-of-sync sidebar)
 * — so there is exactly one source of truth for "what is this service and what
 * can I do with it." A service is the grouping unit
 * (feedback_services_are_the_grouping_unit).
 */
export default function ServiceDetailSummary({
  service,
  showOperateLink = true,
  className = '',
}: {
  service: ServiceViewModel;
  /** Hide the "Open full Operate page" link when already ON the Operate page. */
  showOperateLink?: boolean;
  className?: string;
}) {
  const { counts, checks, loading } = useServiceHealth(service);
  const { restarting, handleRestart } = useServiceRestart(service);

  const serviceName = service.id || service.name;
  const operateHref = `/services/${encodeURIComponent(serviceName)}`;
  const logsHref = `${operateHref}?tab=health`;
  const openUrl = primaryServiceUrl(service);
  const meta = DOT_META[service.active ? overallHealth(counts) : 'unknown'];
  const subtitle = buildSubtitle(service, openUrl);

  return (
    <div className={`space-y-3 ${className}`}>
      <SummaryHeader displayName={service.displayName} active={service.active} meta={meta} subtitle={subtitle} />
      <SummaryActions openUrl={openUrl} logsHref={logsHref} restarting={restarting} onRestart={handleRestart} />
      <HealthRollup checks={checks} counts={counts} loading={loading} />
      {showOperateLink && (
        <Link
          href={operateHref}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          data-service-base={serviceBaseName(service)}
        >
          Open full Operate page <ArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}

/** Build the one-line subtitle (address · uptime · node), falling back to the
 *  description when nothing networky is known. */
function buildSubtitle(service: ServiceViewModel, openUrl: string | null): string {
  const node = service.nodeName && service.nodeName !== 'Local' ? service.nodeName : null;
  return (
    [openUrl?.replace(/^https?:\/\//, ''), formatUptime(service.uptime), node].filter(Boolean).join(' · ') ||
    (service.description ?? '')
  );
}

/** Restart-this-service action shared by the summary's Restart button. */
function useServiceRestart(service: ServiceViewModel) {
  const { addToast, updateToast } = useToast();
  const [restarting, setRestarting] = useState(false);
  const serviceName = service.id || service.name;
  const nodeParam = service.nodeName && service.nodeName !== 'Local' ? `?node=${service.nodeName}` : '';

  const handleRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    const toastId = addToast('loading', 'Restarting…', service.displayName, 0);
    try {
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}/action${nodeParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        updateToast(toastId, 'error', 'Restart failed', data.error || `HTTP ${res.status}`);
      } else {
        updateToast(toastId, 'success', 'Restart initiated', service.displayName);
      }
    } catch (e) {
      logger.error('ServiceDetailSummary', 'restart failed', e);
      updateToast(toastId, 'error', 'Restart failed', 'An unexpected error occurred.');
    } finally {
      setRestarting(false);
    }
  }, [restarting, addToast, updateToast, service.displayName, serviceName, nodeParam]);

  return { restarting, handleRestart };
}

function SummaryHeader({
  displayName,
  active,
  meta,
  subtitle,
}: {
  displayName: string;
  active: boolean;
  meta: { state: StatusState; label: string; text: string };
  subtitle: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <StatusDot state={active ? meta.state : 'unknown'} label={`Service status: ${active ? meta.label : 'Stopped'}`} />
        <h3 className="text-lg font-semibold text-text truncate" title={displayName}>
          {displayName}
        </h3>
        <span className={`text-xs font-medium ${meta.text}`}>{active ? meta.label : 'Stopped'}</span>
      </div>
      <p className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</p>
    </div>
  );
}

const ACTION_CLS =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-card border border-border text-text hover:bg-surface-2 transition-colors';

function SummaryActions({
  openUrl,
  logsHref,
  restarting,
  onRestart,
}: {
  openUrl: string | null;
  logsHref: string;
  restarting: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {openUrl && (
        <a href={openUrl} target="_blank" rel="noopener noreferrer" className={ACTION_CLS}>
          <ExternalLink size={14} /> Open
        </a>
      )}
      <button type="button" onClick={onRestart} disabled={restarting} className={`${ACTION_CLS} disabled:opacity-60`}>
        {restarting ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />} Restart
      </button>
      <Link href={logsHref} className={ACTION_CLS}>
        <ScrollText size={14} /> Logs
      </Link>
    </div>
  );
}

/** Compact per-service health roll-up: counts + the few most relevant checks. */
function HealthRollup({
  checks,
  counts,
  loading,
}: {
  checks: Check[];
  counts: Record<RowStatus, number>;
  loading: boolean;
}) {
  const topChecks = [...checks].sort((a, b) => failRank(a.status) - failRank(b.status)).slice(0, 4);
  return (
    <Card padding="sm">
      <div className="flex gap-3 text-xs mb-2">
        <span className="text-status-ok font-medium">{counts.ok} ok</span>
        {counts.warn > 0 && <span className="text-status-warn font-medium">{counts.warn} warning</span>}
        {counts.fail > 0 && <span className="text-status-fail font-medium">{counts.fail} failing</span>}
      </div>
      {loading ? (
        <p className="text-xs text-text-subtle">Loading health…</p>
      ) : topChecks.length === 0 ? (
        <p className="text-xs text-text-subtle">No health checks for this service.</p>
      ) : (
        <ul className="space-y-1">
          {topChecks.map(check => {
            const rs = (check.status as RowStatus) in CHECK_ICON ? (check.status as RowStatus) : 'unknown';
            const Icon = CHECK_ICON[rs];
            return (
              <li key={check.id} className="flex items-center gap-2 text-xs text-text-muted min-w-0">
                <Icon size={13} className={DOT_META[rs].text + ' shrink-0'} />
                <span className="truncate" title={check.name}>{check.name}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Sort failing/warning checks ahead of healthy ones in the roll-up. */
function failRank(status: string): number {
  if (status === 'fail') return 0;
  if (status === 'warn') return 1;
  if (status === 'unknown') return 2;
  return 3;
}
