'use client';

import { AlertCircle, Download, RotateCcw } from 'lucide-react';
import type { EnrichedContainer, ServiceViewModel } from '@servicebay/api-client';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { DomainHealthDot } from '@/components/DomainHealthDot';

// #1072 Phase 1: ServiceCard extracted from ServicesDashboard.tsx as a
// pure presentational component. The dashboard owns the action
// callbacks and the live-state derived sets (httpsDomains, etc); this
// component just renders them.
//
// IA redesign (spec §4.1 "a tile is a service is a shared purpose"): the
// LIST tile is intentionally lean — status + name + address + service-level
// actions. The implementation detail that used to crowd it here — per-port
// links, volume counts, and the attached-container rows — now lives ONLY on
// the per-service Operate page (`/services/[name]`), so the home list stays a
// clean "one dot = one honest health state" grid. The container/port action
// callbacks remain in the props (the dashboard still passes them) but the tile
// no longer renders them.

export interface ServiceCardProps {
  service: ServiceViewModel;
  /** Map a bare container twin into the same shape the action callbacks
   *  expect (i.e. with nodeName attached). Retained for prop-compat with the
   *  dashboard; no longer used by the lean tile. */
  attachNodeContext: (container: EnrichedContainer, nodeName: string | undefined) => EnrichedContainer;
  /** Domains that NPM is currently serving over HTTPS. Used to pick the
   *  scheme for the per-domain badge links so LAN-only services don't
   *  produce a TLS error on click. */
  httpsDomains: Set<string>;
  /** True when the registry serves a newer image digest than the one this
   *  service is running (from `/api/system/stacks/image-updates`, #1860).
   *  Renders an "Update available" badge. */
  imageUpdateAvailable?: boolean;
  /** When provided, the "Update available" badge becomes a button that
   *  re-deploys this one service to pull its latest image (#1860). */
  onUpdate?: (service: ServiceViewModel) => void;
  // Service-row actions (ServiceActionBar + failed-state nudge).
  onMonitor: (service: ServiceViewModel) => void;
  onEdit: (service: ServiceViewModel) => void;
  onActions: (service: ServiceViewModel) => void;
  onEditLink: (service: ServiceViewModel) => void;
  onDelete: (service: ServiceViewModel) => void;
  onRestart: (service: ServiceViewModel) => void;
  // Attached-container actions — kept for prop-compat with ServicesDashboard;
  // the lean list tile no longer renders the container rows (they moved to the
  // Operate page), so these are intentionally not consumed here.
  onContainerLogs: (container: EnrichedContainer) => void;
  onContainerTerminal: (container: EnrichedContainer) => void;
  onContainerActions: (container: EnrichedContainer) => void;
}

export default function ServiceCard({
  service,
  httpsDomains,
  imageUpdateAvailable,
  onUpdate,
  onMonitor,
  onEdit,
  onActions,
  onEditLink,
  onDelete,
  onRestart,
}: ServiceCardProps) {
  return (
    <div className="group self-start bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200 relative overflow-hidden min-w-0">
      <div className="flex items-start gap-4 justify-between mb-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {(() => {
            // 3-state status indicator. systemd transitional states ("activating",
            // "reloading", "deactivating") and crash-loop subState "auto-restart"
            // mean the service isn't healthy *yet* but isn't a hard failure either.
            const transitional = ['activating', 'reloading', 'deactivating'].includes(service.activeState ?? '') || service.subState === 'auto-restart';
            const dotClass = transitional
              ? 'bg-amber-500 animate-pulse'
              : service.active
                ? 'bg-green-500'
                : 'bg-red-500';
            const dotTitle = transitional
              ? `${service.activeState ?? 'transitioning'}${service.subState ? ` (${service.subState})` : ''}`
              : service.status;
            return <div className={`mt-1.5 w-3 h-3 shrink-0 rounded-full ${dotClass}`} title={dotTitle} />;
          })()}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h3
                className="font-bold text-lg text-gray-900 dark:text-gray-100 truncate"
                title={service.name}
                data-testid={`service-name-${service.displayName}`}
              >
                {service.displayName}
              </h3>
              {service.nodeName && service.nodeName !== 'Local' && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded">
                  {service.nodeName}
                </span>
              )}
              {service.type === 'link' && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800 rounded">
                  External Link
                </span>
              )}
              {service.type === 'gateway' && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800 rounded">
                  Gateway
                </span>
              )}
              {service.labels && service.labels['servicebay.role'] === 'reverse-proxy' && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded">
                  Reverse Proxy
                </span>
              )}
              {service.labels && service.labels['servicebay.role'] === 'system' && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 rounded">
                  System
                </span>
              )}
              {imageUpdateAvailable && (
                onUpdate ? (
                  <button
                    type="button"
                    onClick={() => onUpdate(service)}
                    className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 rounded hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    title="A newer image is available in the registry. Click to re-deploy this service and pull it."
                  >
                    <Download size={10} /> Update now
                  </button>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 rounded"
                    title="A newer image is available in the registry. Re-deploy this service to pull it."
                  >
                    <Download size={10} /> Update available
                  </span>
                )
              )}
            </div>
          </div>
        </div>
        <ServiceActionBar
          service={service}
          onMonitor={onMonitor}
          onEdit={onEdit}
          onActions={onActions}
          onEditLink={onEditLink}
          onDelete={onDelete}
        />
      </div>

      {/* Failed-state nudge: when a managed service is not active, surface a
          one-click restart + logs instead of forcing a dig through Actions.
          Hidden for gateway/link "services" (own lifecycle). */}
      {!service.active && service.type !== 'gateway' && service.type !== 'link' && (
        <div className="mb-3 -mt-1 flex items-center gap-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 text-sm text-red-800 dark:text-red-200">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1 truncate" title={service.status}>Service is {service.status || 'inactive'}.</span>
          <button
            type="button"
            onClick={() => onRestart(service)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-red-300 dark:border-red-700 text-red-800 dark:text-red-100 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
            title="Restart this service"
          >
            <RotateCcw size={12} /> Restart
          </button>
          <button
            type="button"
            onClick={() => onMonitor(service)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-red-300 dark:border-red-700 text-red-800 dark:text-red-100 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
            title="View recent logs"
          >
            View logs
          </button>
        </div>
      )}

      {/* Address — the one thing a tile needs beyond name + health: where the
          service lives. Sits directly under the name (no mt-auto: the tile is
          content-height, not stretched, so there's no empty gap). Gateway/link
          carry their own "address" shape. */}
      <div className="mt-2">
        {service.type === 'gateway' ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-mono text-gray-600 dark:text-gray-300">{service.externalIP || 'N/A'}</span>
            {service.internalIP && <span className="font-mono text-gray-400 dark:text-gray-500">· {service.internalIP}</span>}
          </div>
        ) : service.type === 'link' ? (
          <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline break-all">
            {service.url}
          </a>
        ) : (service.verifiedDomains && service.verifiedDomains.length > 0) ? (
          <div className="flex flex-wrap gap-1.5">
            {service.verifiedDomains.map(d => {
              // Strip scheme + path so the health-check key (registered against
              // the bare domain) matches the digital twin. Pick the scheme NPM
              // actually serves so LAN-only domains don't TLS-error on click.
              const bareDomain = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
              const looksLikeDomain = /\./.test(bareDomain);
              const scheme = httpsDomains.has(bareDomain.toLowerCase()) ? 'https' : 'http';
              const href = d.startsWith('http') ? d : `${scheme}://${d}`;
              return (
                <span key={d} className="inline-flex items-center gap-1.5 text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded">
                  {looksLikeDomain && <DomainHealthDot domain={bareDomain} />}
                  <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">{d}</a>
                </span>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">No public address</span>
        )}
      </div>
    </div>
  );
}
