'use client';

import { AlertCircle, Download, RotateCcw } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { DomainHealthDot } from '@/components/DomainHealthDot';

// #2067: the Services overview reads as a list on desktop, not a card grid
// (operator feedback on 4.138.0). ServiceRow is the desktop list-row twin of
// ServiceCard: same data (ServiceViewModel), same action callbacks, same lean
// content (status dot + name + badges + address + ServiceActionBar) — just laid
// out as one tight table-like row instead of a card. ServiceCard stays for the
// mobile single-column stack; the dashboard renders one or the other per
// breakpoint (`hidden md:flex` vs `md:hidden`).

export interface ServiceRowProps {
  service: ServiceViewModel;
  /** Domains NPM is serving over HTTPS — picks the scheme for the per-domain
   *  link so LAN-only services don't TLS-error on click. */
  httpsDomains: Set<string>;
  /** Registry has a newer image digest than the running one (#1860). */
  imageUpdateAvailable?: boolean;
  /** When provided, the "Update available" badge becomes a button that
   *  re-deploys this one service to pull its latest image (#1860). */
  onUpdate?: (service: ServiceViewModel) => void;
  onMonitor: (service: ServiceViewModel) => void;
  onEdit: (service: ServiceViewModel) => void;
  onActions: (service: ServiceViewModel) => void;
  onEditLink: (service: ServiceViewModel) => void;
  onDelete: (service: ServiceViewModel) => void;
  onRestart: (service: ServiceViewModel) => void;
}

const badgeBase = 'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 border rounded';

export default function ServiceRow({
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
}: ServiceRowProps) {
  // 3-state status dot (mirrors ServiceCard): systemd transitional states and
  // the crash-loop "auto-restart" subState are amber, active is green, else red.
  const transitional =
    ['activating', 'reloading', 'deactivating'].includes(service.activeState ?? '') ||
    service.subState === 'auto-restart';
  const dotClass = transitional ? 'bg-amber-500 animate-pulse' : service.active ? 'bg-green-500' : 'bg-red-500';
  const dotTitle = transitional
    ? `${service.activeState ?? 'transitioning'}${service.subState ? ` (${service.subState})` : ''}`
    : service.status;

  const showFailedNudge = !service.active && service.type !== 'gateway' && service.type !== 'link';

  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors min-w-0">
      {/* Status dot */}
      <div className={`w-3 h-3 shrink-0 rounded-full ${dotClass}`} title={dotTitle} />

      {/* Name + badges */}
      <div className="flex items-center gap-2 min-w-0 basis-1/3 shrink-0">
        <h3
          className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate"
          title={service.name}
          data-testid={`service-name-${service.displayName}`}
        >
          {service.displayName}
        </h3>
        {service.nodeName && service.nodeName !== 'Local' && (
          <span className={`${badgeBase} bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800`}>
            {service.nodeName}
          </span>
        )}
        {service.type === 'link' && (
          <span className={`${badgeBase} bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800`}>
            External Link
          </span>
        )}
        {service.type === 'gateway' && (
          <span className={`${badgeBase} bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800`}>
            Gateway
          </span>
        )}
        {service.labels && service.labels['servicebay.role'] === 'reverse-proxy' && (
          <span className={`${badgeBase} bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800`}>
            Reverse Proxy
          </span>
        )}
        {service.labels && service.labels['servicebay.role'] === 'system' && (
          <span className={`${badgeBase} bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800`}>
            System
          </span>
        )}
        {imageUpdateAvailable && (
          onUpdate ? (
            <button
              type="button"
              onClick={() => onUpdate(service)}
              className={`inline-flex items-center gap-1 ${badgeBase} bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
              title="A newer image is available in the registry. Click to re-deploy this service and pull it."
            >
              <Download size={10} /> Update now
            </button>
          ) : (
            <span
              className={`inline-flex items-center gap-1 ${badgeBase} bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800`}
              title="A newer image is available in the registry. Re-deploy this service to pull it."
            >
              <Download size={10} /> Update available
            </span>
          )
        )}
      </div>

      {/* Address — same shapes as ServiceCard (gateway IPs / link URL /
          verified domains with health dots / "No public address"). */}
      <div className="flex-1 min-w-0">
        {service.type === 'gateway' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-mono text-gray-600 dark:text-gray-300">{service.externalIP || 'N/A'}</span>
            {service.internalIP && <span className="font-mono text-gray-400 dark:text-gray-500">· {service.internalIP}</span>}
          </div>
        ) : service.type === 'link' ? (
          <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline break-all">
            {service.url}
          </a>
        ) : service.verifiedDomains && service.verifiedDomains.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {service.verifiedDomains.map(d => {
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

      {/* Failed-state nudge — compact inline restart/logs, mirrors ServiceCard. */}
      {showFailedNudge && (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="hidden xl:inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300" title={service.status}>
            <AlertCircle size={12} className="shrink-0" /> {service.status || 'inactive'}
          </span>
          <button
            type="button"
            onClick={() => onRestart(service)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-red-300 dark:border-red-700 text-red-800 dark:text-red-100 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
            title="Restart this service"
          >
            <RotateCcw size={12} /> Restart
          </button>
        </div>
      )}

      {/* Action bar */}
      <ServiceActionBar
        service={service}
        className="shrink-0"
        onMonitor={onMonitor}
        onEdit={onEdit}
        onActions={onActions}
        onEditLink={onEditLink}
        onDelete={onDelete}
      />
    </div>
  );
}
