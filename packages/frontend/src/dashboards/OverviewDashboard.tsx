'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, AlertCircle, Boxes, CheckCircle2, Server } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useDigitalTwinContext } from '@/providers/DigitalTwinProvider';
import { useCoreHealth } from '@/hooks/useCoreHealth';
import { useImageUpdates, type ServiceImageUpdate } from '@/hooks/useImageUpdates';
import { useServiceActions } from '@/hooks/useServiceActions';
import ImageUpdatesPendingBanner from '@/components/ImageUpdatesPendingBanner';
import ServiceBayUpdateCard from '@/components/ServiceBayUpdateCard';
import { Card, SectionHeading, StatusDot } from '@/components/ui';
import { cn } from '@/components/ui';

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
 * "Last updated" freshness/security view (#2104).
 *
 * Reads the applied-update timestamp the updater stamps into config
 * (`autoUpdate.appliedImageUpdatedAt`, surfaced by GET /api/system/update which
 * returns the full config). Renders a human-relative value with an ok/warn
 * tone: a box updated recently is current/secure (ok); one that hasn't seen an
 * update in a long time is a freshness risk (warn). Never-updated (fresh
 * install, no applied update yet) is neutral, not a warning — there may simply
 * be nothing newer than the shipped image.
 */
export interface LastUpdatedView {
  value: string;
  tone: 'good' | 'warn' | 'neutral';
}

/** Warn once the last applied update is older than this (days). 60d ≈ several
 *  release cycles for this repo — long enough to flag a stale box without
 *  nagging a current one. */
const LAST_UPDATE_WARN_DAYS = 60;

export function lastUpdatedView(
  appliedAt: string | null | undefined,
  now: number = Date.now(),
): LastUpdatedView {
  if (!appliedAt) return { value: 'Never', tone: 'neutral' };
  const then = Date.parse(appliedAt);
  if (Number.isNaN(then)) return { value: 'Never', tone: 'neutral' };
  const ageMs = Math.max(0, now - then);
  const days = Math.floor(ageMs / 86400000);
  const hours = Math.floor(ageMs / 3600000);
  const value =
    days >= 1 ? `${days}d ago` : hours >= 1 ? `${hours}h ago` : 'Just now';
  const tone: 'good' | 'warn' = days >= LAST_UPDATE_WARN_DAYS ? 'warn' : 'good';
  return { value, tone };
}

/** Read the applied-update timestamp off GET /api/system/update (same endpoint
 *  the ServiceBay updater card uses). Read-only background fetch; failure keeps
 *  the value neutral ("Never") rather than surfacing a transient blip. */
function useLastUpdated(): string | null {
  const [appliedAt, setAppliedAt] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/update');
        if (!res.ok) return;
        const data = (await res.json()) as {
          config?: { autoUpdate?: { appliedImageUpdatedAt?: string } };
        };
        if (cancelled) return;
        setAppliedAt(data.config?.autoUpdate?.appliedImageUpdatedAt ?? null);
      } catch (error) {
        console.error('[OverviewDashboard] Failed to read last-update time', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return appliedAt;
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

  // "Last updated" freshness indicator (#2104) — applied-update timestamp from
  // config via GET /api/system/update. Read-only background fetch.
  const lastUpdatedAt = useLastUpdated();

  // Compact System-status tile (#2096) — sourced from the SAME twin snapshot
  // Status→System reads (firstNode.resources). No new polling: the twin is
  // already in context. Unavailable (no agent report yet) → neutral, no crash.
  // Disk is split into System (/) + Data (/mnt/data) from resources.disks[];
  // Uptime is replaced by "Last updated" (#2104).
  const systemView = systemStatusView(firstNode?.resources, lastUpdatedAt);

  // Pending service-image updates — box status, so it belongs on Home too
  // (#1860). The banner's "Update now" re-deploys each listed service via the
  // same `update` action the Services list uses (pull latest image → restart).
  const { available: imageUpdates, refresh: refreshImageUpdates, verifyAfterUpdate } = useImageUpdates();
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
    // Re-check on a short back-off: the registry report lags the pull/restart,
    // so a single immediate refresh can still show the stale entry (#2106).
    await verifyAfterUpdate();
  }, [services, firstNodeName, updateServiceImage, verifyAfterUpdate]);

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
          <h1 className="text-2xl font-bold text-text">Home</h1>
          <p className="text-sm text-text-muted mt-1">
            {data?.serverName || firstNode?.resources?.os?.hostname || 'ServiceBay'}
            {!isConnected && hasFirstSnapshot && (
              <span className="ml-2 text-xs text-status-warn">· reconnecting…</span>
            )}
          </p>
        </header>

        {/* Headline status — the single sentence that answers "is everything OK?" */}
        <HealthHeadline tone={healthHeadline.tone} text={healthHeadline.text} />

        {/* Updates — one coherent area (#2082): the ServiceBay self-updater
            (version status + "Update now", GET/POST /api/system/update) and the
            per-service image updates (#1860/#2069) together, each with its own
            trigger. The image banner renders nothing when no images are pending,
            but the SB updater card always shows current version + Check Now, so
            the section is never empty. */}
        <section className="space-y-3">
          <SectionHeading description="Keep ServiceBay and your services up to date">Updates</SectionHeading>
          <ServiceBayUpdateCard />
          <ImageUpdatesPendingBanner updates={imageUpdates} onUpdate={handleUpdateAll} />
        </section>

        {/* Box-wide at-a-glance: services running + latest diagnose breakdown
            + a compact System-status tile (#2096). Every tile shares ONE header
            layout — icon + title on a single row (#2103). On narrow screens the
            Diagnostics/Health tile drops to the bottom (#2105): the more
            important Services + System tiles come first; desktop order (grid
            source order) is unchanged. */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            title="Services"
            icon={Boxes}
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
            /* Mobile: push to bottom; ≥sm: back to natural source order (2nd). */
            className="order-last sm:order-none"
          />
          <SystemStatusCard view={systemView} />
        </section>
      </div>
    </div>
  );
}

/** Tone → status/accent token classes, shared by HealthHeadline (tinted
 *  surface) and StatCard (accent text). `good/warn/bad` map to the status
 *  tokens; `neutral` to the accent (a "no issue / navigate here" hue). */
const TONE_SURFACE: Record<'good' | 'warn' | 'bad' | 'neutral', string> = {
  good: 'bg-status-ok/10 border-status-ok/20 text-status-ok',
  warn: 'bg-status-warn/10 border-status-warn/20 text-status-warn',
  bad: 'bg-status-fail/10 border-status-fail/20 text-status-fail',
  neutral: 'bg-surface-2 border-border text-text-muted',
};

const TONE_ACCENT: Record<'good' | 'warn' | 'bad' | 'neutral', string> = {
  good: 'text-status-ok',
  warn: 'text-status-warn',
  bad: 'text-status-fail',
  neutral: 'text-accent',
};

function HealthHeadline({ tone, text }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }) {
  const Icon = tone === 'bad' || tone === 'warn' ? AlertCircle : CheckCircle2;
  // Tinted status surface — not a <Card> (Card is a neutral bg-surface); the
  // tone tokens here own both the fill and the border, fully token-driven.
  return (
    <div className={cn('flex items-center gap-3 rounded-card border px-4 py-3.5 transition-all duration-300', TONE_SURFACE[tone])}>
      <Icon size={20} className="shrink-0" />
      <span className="text-sm font-semibold tracking-wide">{text}</span>
    </div>
  );
}

/**
 * Shared Home-tile header (#2103) — icon + title on ONE row, icon left, title
 * beside it. The single source of truth for every Home tile's heading so they
 * can't drift apart again (the bug: Services had no icon, Diagnostics/System
 * stacked the icon ABOVE the title). `accent` colours the icon to the tile's
 * tone; an optional `trailing` slot carries the System tile's StatusDot.
 */
function TileHeader({
  title,
  icon: Icon,
  accent,
  trailing,
}: {
  title: string;
  icon: typeof Activity;
  accent: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon size={20} className={cn('shrink-0', accent)} />
      <h2 className="font-bold text-text tracking-wide text-base">{title}</h2>
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}

interface StatCardProps {
  title: string;
  metric: string;
  description: string;
  icon: typeof Activity;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  /** Where clicking the card navigates (#2067 — the Home cards used to be
   *  inert; the operator clicked them and nothing happened). When set, the
   *  card renders as a Next <Link> with a clear hover affordance. */
  href?: string;
  /** Extra wrapper classes — e.g. responsive `order-*` for mobile reordering. */
  className?: string;
}

function StatCard({ title, metric, description, icon: Icon, tone, href, className }: StatCardProps) {
  const accent = TONE_ACCENT[tone];
  const inner = (
    <>
      <TileHeader title={title} icon={Icon} accent={accent} />
      <p className={cn('text-sm font-semibold', accent)}>{metric}</p>
      <p className="text-xs text-text-muted mt-2 font-medium leading-relaxed">{description}</p>
    </>
  );
  if (href) {
    // Clickable navigation card (#2067) — a Next <Link> (the real <a>, keeps
    // the href) wrapping a <Card> surface, with a token-driven hover affordance
    // (accent border + accent ring).
    return (
      <Link href={href} className={cn('block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}>
        <Card padding="lg" className="cursor-pointer transition-all hover:border-accent hover:shadow-md">
          {inner}
        </Card>
      </Link>
    );
  }
  return <Card padding="lg" className={className}>{inner}</Card>;
}

/** Shape of the resources slice the System tile reads off the twin — a subset
 *  of the agent's `SystemResources` (the same object Status→System binds to).
 *  `disks[]` is the per-mount partition breakdown the System report carries
 *  (same source SystemInfoDashboard reads); used to split System (/) vs Data
 *  (/mnt/data) usage (#2104). `diskUsage` is the single fallback figure. */
interface DiskLike {
  mountpoint?: string;
  total?: number;
  used?: number;
}
interface SystemResourcesLike {
  cpuUsage?: number;
  memoryUsage?: number;
  totalMemory?: number;
  diskUsage?: number;
  disks?: DiskLike[];
  os?: { uptime?: number };
}

interface SystemRow {
  label: string;
  value: string;
  /** Per-metric tone so the worst metric drives the dot, but each row keeps
   *  its own colour. Undefined → neutral (no usage figure available). */
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

export interface SystemStatusView {
  loaded: boolean;
  /** Worst-of tone across the metrics — drives the StatusDot. */
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  rows: SystemRow[];
}

function formatBytesShort(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

/** A usage percentage → tone, matching the Status→System thresholds
 *  (>90 fail, >80 warn, else ok). */
function usageTone(percent: number): 'good' | 'warn' | 'bad' {
  if (percent > 90) return 'bad';
  if (percent > 80) return 'warn';
  return 'good';
}

/** The mountpoints that identify the two partitions the box runs on. The OS
 *  root and the /mnt/data RAID (FCoS mounts it under /var/mnt/data; pre-FCoS or
 *  bind setups use /mnt/data — accept both). Mirrors SystemInfoDashboard's
 *  `describeMountRole`. */
const SYSTEM_MOUNTS = ['/', '/sysroot'];
const DATA_MOUNTS = ['/var/mnt/data', '/mnt/data'];

function findDisk(disks: DiskLike[] | undefined, mounts: string[]): DiskLike | undefined {
  if (!disks) return undefined;
  for (const m of mounts) {
    const hit = disks.find(d => d.mountpoint === m);
    if (hit) return hit;
  }
  return undefined;
}

/** A disk mount → a usage row (used%/tone). Returns null when the figure can't
 *  be computed (mount absent / no total) so the caller can render an em-dash. */
function diskRow(label: string, disk: DiskLike | undefined): { row: SystemRow; tone: 'good' | 'warn' | 'bad' } | { row: SystemRow; tone: null } {
  if (disk && typeof disk.used === 'number' && typeof disk.total === 'number' && disk.total > 0) {
    const pct = (disk.used / disk.total) * 100;
    const t = usageTone(pct);
    return { row: { label, value: `${Math.round(pct)}%`, tone: t }, tone: t };
  }
  return { row: { label, value: '—', tone: 'neutral' }, tone: null };
}

/** The disk section (#2104): System (/) + Data (/mnt/data) split from the
 *  report's per-mount `disks[]`. Falls back to the single `diskUsage` figure
 *  (one "Disk" row) when the agent carries no per-mount breakdown — rather than
 *  fabricate a split. Returns the rows + the tones that should escalate the
 *  worst-of system tone. */
function diskSection(resources: SystemResourcesLike): { rows: SystemRow[]; tones: ('good' | 'warn' | 'bad')[] } {
  if (Array.isArray(resources.disks) && resources.disks.length > 0) {
    const sys = diskRow('System', findDisk(resources.disks, SYSTEM_MOUNTS));
    const dat = diskRow('Data', findDisk(resources.disks, DATA_MOUNTS));
    const tones = [sys.tone, dat.tone].filter((t): t is 'good' | 'warn' | 'bad' => t !== null);
    return { rows: [sys.row, dat.row], tones };
  }
  if (typeof resources.diskUsage === 'number') {
    const t = usageTone(resources.diskUsage);
    return { rows: [{ label: 'Disk', value: `${Math.round(resources.diskUsage)}%`, tone: t }], tones: [t] };
  }
  return { rows: [{ label: 'Disk', value: '—', tone: 'neutral' }], tones: [] };
}

/** Build the compact System-status view from the twin's resources slice +
 *  the last-applied-update timestamp. Read-only, no fetch — the parent already
 *  holds the snapshot. Missing / partial data degrades gracefully to neutral
 *  rows rather than crashing.
 *
 *  #2104: Disk is split into System (/) and Data (/mnt/data) from the report's
 *  per-mount `disks[]` (the same source SystemInfoDashboard uses). When the
 *  agent only carries the single `diskUsage` figure (older report, no
 *  per-mount breakdown), we surface that one "Disk" row rather than fake a
 *  split. Uptime is replaced by "Last updated" (update freshness/security). */
export function systemStatusView(
  resources: SystemResourcesLike | null | undefined,
  lastUpdatedAt?: string | null,
): SystemStatusView {
  if (!resources || resources.os === undefined) {
    return { loaded: false, tone: 'neutral', rows: [] };
  }

  const rows: SystemRow[] = [];
  const tones: ('good' | 'warn' | 'bad')[] = [];

  if (typeof resources.cpuUsage === 'number') {
    const t = usageTone(resources.cpuUsage);
    tones.push(t);
    rows.push({ label: 'CPU', value: `${Math.round(resources.cpuUsage)}%`, tone: t });
  } else {
    rows.push({ label: 'CPU', value: '—', tone: 'neutral' });
  }

  if (typeof resources.memoryUsage === 'number' && typeof resources.totalMemory === 'number' && resources.totalMemory > 0) {
    const pct = (resources.memoryUsage / resources.totalMemory) * 100;
    const t = usageTone(pct);
    tones.push(t);
    rows.push({
      label: 'RAM',
      value: `${formatBytesShort(resources.memoryUsage)} / ${formatBytesShort(resources.totalMemory)}`,
      tone: t,
    });
  } else {
    rows.push({ label: 'RAM', value: '—', tone: 'neutral' });
  }

  // Disk split (#2104): System (/) + Data (/mnt/data), or a single fallback.
  const disk = diskSection(resources);
  rows.push(...disk.rows);
  tones.push(...disk.tones);

  // Last updated (#2104) — replaces Uptime. Update freshness/security; its own
  // ok/warn tone does NOT escalate the worst-of system tone (a stale box isn't
  // a CPU/RAM/disk pressure problem), so it's pushed as a row only.
  const lu = lastUpdatedView(lastUpdatedAt);
  rows.push({ label: 'Last updated', value: lu.value, tone: lu.tone });

  const tone: 'good' | 'warn' | 'bad' | 'neutral' = tones.includes('bad')
    ? 'bad'
    : tones.includes('warn')
      ? 'warn'
      : tones.length > 0
        ? 'good'
        : 'neutral';

  return { loaded: true, tone, rows };
}

const TONE_TO_DOT: Record<'good' | 'warn' | 'bad' | 'neutral', 'ok' | 'warn' | 'fail' | 'unknown'> = {
  good: 'ok',
  warn: 'warn',
  bad: 'fail',
  neutral: 'unknown',
};

/** Compact System-status tile (#2096) — CPU / RAM / Disk / Uptime at a glance,
 *  clickable → Status→System (`/status?tab=system`). Reads off the twin
 *  resources the parent already holds (no new heavy polling); a box with no
 *  agent report yet renders a neutral "Waiting" state, never a crash. */
function SystemStatusCard({ view }: { view: SystemStatusView }) {
  return (
    <Link
      href="/status?tab=system"
      className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Card padding="lg" className="cursor-pointer transition-all hover:border-accent hover:shadow-md">
        <TileHeader
          title="System"
          icon={Server}
          accent={TONE_ACCENT[view.tone]}
          trailing={<StatusDot state={TONE_TO_DOT[view.tone]} />}
        />
        {view.loaded ? (
          <dl className="mt-2 space-y-1.5">
            {view.rows.map(row => (
              <div key={row.label} className="flex items-center justify-between gap-2 text-xs">
                <dt className="text-text-muted font-medium">{row.label}</dt>
                <dd className={cn('font-semibold tabular-nums', TONE_ACCENT[row.tone])}>{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-text-muted mt-2 font-medium leading-relaxed">Waiting for system report…</p>
        )}
      </Card>
    </Link>
  );
}
