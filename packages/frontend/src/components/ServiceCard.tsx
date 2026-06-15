'use client';

import { useCallback, useMemo } from 'react';
import { AlertCircle, Download, RotateCcw } from 'lucide-react';
import type { EnrichedContainer, ServicePort, ServiceViewModel } from '@servicebay/api-client';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { AttachedContainerList } from '@/components/AttachedContainerList';
import { DomainHealthDot } from '@/components/DomainHealthDot';

// #1072 Phase 1: ServiceCard extracted from ServicesDashboard.tsx as a
// pure presentational component. The dashboard owns the action
// callbacks and the live-state derived sets (httpsDomains, etc); this
// component just renders them. Behaviour is byte-identical with the
// previous inline definition.

export interface ServiceCardProps {
  service: ServiceViewModel;
  /** Map a bare container twin into the same shape the action callbacks
   *  expect (i.e. with nodeName attached). The dashboard owns this so
   *  the card stays oblivious to multi-node bookkeeping. */
  attachNodeContext: (container: EnrichedContainer, nodeName: string | undefined) => EnrichedContainer;
  /** Domains that NPM is currently serving over HTTPS. Used to pick the
   *  scheme for the per-domain badge links so LAN-only services don't
   *  produce a TLS error on click. */
  httpsDomains: Set<string>;
  /** True when the registry serves a newer image digest than the one this
   *  service is running (from `/api/system/stacks/image-updates`, #1860).
   *  Renders an "Update available" badge. Independent of the schema-version
   *  "template upgrade" surface. */
  imageUpdateAvailable?: boolean;
  // Service-row actions (ServiceActionBar + failed-state nudge).
  onMonitor: (service: ServiceViewModel) => void;
  onEdit: (service: ServiceViewModel) => void;
  onActions: (service: ServiceViewModel) => void;
  onEditLink: (service: ServiceViewModel) => void;
  onDelete: (service: ServiceViewModel) => void;
  onRestart: (service: ServiceViewModel) => void;
  // Attached-container actions (AttachedContainerList).
  onContainerLogs: (container: EnrichedContainer) => void;
  onContainerTerminal: (container: EnrichedContainer) => void;
  onContainerActions: (container: EnrichedContainer) => void;
}

export default function ServiceCard({
  service,
  attachNodeContext,
  httpsDomains,
  imageUpdateAvailable,
  onMonitor,
  onEdit,
  onActions,
  onEditLink,
  onDelete,
  onRestart,
  onContainerLogs,
  onContainerTerminal,
  onContainerActions,
}: ServiceCardProps) {
  const dedupedPorts = useMemo(() => {
    const uniquePortsMap = new Map<string, ServicePort>();
    service.ports.forEach(p => {
      const key = `${p.host || '_'}:${p.container}`;
      if (!uniquePortsMap.has(key)) {
        uniquePortsMap.set(key, p);
      }
    });
    return Array.from(uniquePortsMap.values());
  }, [service.ports]);

  const ensureContainerContext = useCallback(
    (container: EnrichedContainer) => attachNodeContext(container, service.nodeName),
    [attachNodeContext, service.nodeName],
  );

  return (
    <div className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200 relative overflow-hidden flex flex-col h-full min-w-0">
      <div className="flex items-start gap-4 justify-between mb-4">
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
              {service.externalIP && service.type !== 'gateway' && (
                <span className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-1.5 py-0.5 rounded">
                  IP: {service.externalIP}
                </span>
              )}
              {imageUpdateAvailable && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 rounded"
                  title="A newer image is available in the registry. Re-deploy this service to pull it."
                >
                  <Download size={10} /> Update available
                </span>
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

      {/* Failed-state nudge: when a managed service is not active,
          surface a one-click restart and a direct link to logs
          instead of forcing the user to dig through the Actions
          menu. Hidden for gateway/link "services" because they
          have their own lifecycle. */}
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

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4 bg-gray-50/50 dark:bg-gray-800/20 rounded-md p-3 border border-gray-100 dark:border-gray-800/50 flex-1">
        {service.type === 'gateway' ? (
          <>
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Ext IP</span>
              <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.externalIP || 'N/A'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Int IP</span>
              <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.internalIP || 'N/A'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Uptime</span>
              <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.uptime ? `${Math.floor(service.uptime / 3600)}h` : 'N/A'}</span>
            </div>
            {service.dnsServers && (
              <div className="flex flex-col col-span-2">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">DNS Servers</span>
                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.dnsServers.join(', ')}</span>
              </div>
            )}
          </>
        ) : service.type === 'link' ? (
          <div className="col-span-full">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block">Target URL</span>
            <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline break-all">
              {service.url}
            </a>
            {service.ipTargets && service.ipTargets.length > 0 && (
              <div className="mt-3">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block">IP Targets</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {service.ipTargets.map(target => (
                    <span key={target} className="px-2 py-0.5 rounded text-xs font-mono border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300">
                      {target}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {service.verifiedDomains && service.verifiedDomains.length > 0 && (
              <div className="flex flex-col col-span-2">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Domains</span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {service.verifiedDomains.map(d => {
                    // Strip scheme + trailing path so the health-check key
                    // (registered against the bare domain) matches whatever
                    // form the digital twin gives us back. Only domains that
                    // look like a hostname get a dot — internal markers like
                    // `localhost-nginx-proxy-manager` slip through unchanged.
                    const bareDomain = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                    const looksLikeDomain = /\./.test(bareDomain);
                    // Pick the scheme NPM actually serves for this domain.
                    // LAN-only services have no 443 listener → linking
                    // them via https:// produces a TLS error on click.
                    const scheme = httpsDomains.has(bareDomain.toLowerCase()) ? 'https' : 'http';
                    const href = d.startsWith('http') ? d : `${scheme}://${d}`;
                    return (
                      <span key={d} className="inline-flex items-center gap-1.5 text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded">
                        {looksLikeDomain && <DomainHealthDot domain={bareDomain} />}
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {d}
                        </a>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-gray-100 dark:border-gray-800/50 mt-auto">
        {dedupedPorts.length > 0 && (
          <div className="flex gap-2 items-center text-sm">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Ports:</span>
            <div className="flex flex-wrap gap-1.5">
              {dedupedPorts.map((p, i) => {
                const display = p.host ? `:${p.host}` : `${p.container}/tcp`;
                return (
                  <a
                    key={`${display}-${i}`}
                    href={p.host ? `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${p.host}` : '#'}
                    target={p.host ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${
                      p.host
                        ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer'
                        : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800/30 cursor-default'
                    }`}
                    title={p.container ? `Container Port: ${p.container}` : 'Host Port'}
                    onClick={(e) => !p.host && e.preventDefault()}
                  >
                    {display}
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {service.volumes && service.volumes.length > 0 && (
          <div className="flex gap-2 items-center text-sm ml-auto">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Volumes:</span>
            <span className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700" title={service.volumes.map(v => `${v.host} -> ${v.container}`).join('\n')}>
              {service.volumes.length}
            </span>
          </div>
        )}
      </div>
      <AttachedContainerList
        containers={service.attachedContainers}
        onLogs={service.attachedContainers && service.attachedContainers.length > 0 ? (container) => onContainerLogs(ensureContainerContext(container)) : undefined}
        onTerminal={service.attachedContainers && service.attachedContainers.length > 0 ? (container) => onContainerTerminal(ensureContainerContext(container)) : undefined}
        onActions={service.attachedContainers && service.attachedContainers.length > 0 ? (container) => onContainerActions(ensureContainerContext(container)) : undefined}
      />
    </div>
  );
}
