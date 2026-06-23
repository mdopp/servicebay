'use client';

import { useRouter } from 'next/navigation';
import { AlertCircle, Crosshair, Download, RotateCcw } from 'lucide-react';
import type { EnrichedContainer, ServiceViewModel } from '@servicebay/api-client';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { networkFocusHref } from '@/components/networkFocus';
import { DomainHealthDot } from '@/components/DomainHealthDot';
import { serviceDotState } from '@/components/ServiceRow';
import { Badge, Button, Card, StatusDot } from '@/components/ui';

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
  const router = useRouter();
  const dot = serviceDotState(service);
  // #2108: per-service "focus in network map" jump (managed services only).
  const showNetworkFocus = service.type !== 'gateway' && service.type !== 'link';
  return (
    <Card padding="md" className="group self-start hover:shadow-md transition-all duration-200 relative overflow-hidden min-w-0">
      <div className="flex items-start gap-4 justify-between mb-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <StatusDot
            state={dot.state}
            label={dot.title}
            title={dot.title}
            className={`mt-1.5 shrink-0 ${dot.pulse ? 'animate-pulse' : ''}`}
          />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h3
                className="font-bold text-lg text-text truncate"
                title={service.name}
                data-testid={`service-name-${service.displayName}`}
              >
                {service.displayName}
              </h3>
              {service.nodeName && service.nodeName !== 'Local' && (
                <Badge variant="warn">{service.nodeName}</Badge>
              )}
              {service.type === 'link' && <Badge variant="info">External Link</Badge>}
              {service.type === 'gateway' && <Badge variant="warn">Gateway</Badge>}
              {service.labels && service.labels['servicebay.role'] === 'reverse-proxy' && (
                <Badge variant="ok">Reverse Proxy</Badge>
              )}
              {service.labels && service.labels['servicebay.role'] === 'system' && (
                <Badge variant="accent">System</Badge>
              )}
              {imageUpdateAvailable &&
                (onUpdate ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onUpdate(service)}
                    className="h-auto py-0.5 text-xs"
                    title="A newer image is available in the registry. Click to re-deploy this service and pull it."
                  >
                    <Download size={12} /> Update now
                  </Button>
                ) : (
                  <Badge variant="info" title="A newer image is available in the registry. Re-deploy this service to pull it.">
                    <Download size={10} /> Update available
                  </Badge>
                ))}
            </div>
          </div>
        </div>
        {showNetworkFocus && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(networkFocusHref(service.name))}
            aria-label="Im Netzwerk anzeigen"
            title="Im Netzwerk anzeigen"
            className="shrink-0 px-2"
            data-testid={`network-focus-${service.displayName}`}
          >
            <Crosshair size={16} />
          </Button>
        )}
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
        <div className="mb-3 -mt-1 flex items-center gap-2 px-3 py-2 rounded-card bg-status-fail/10 border border-status-fail/20 text-sm text-status-fail">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1 truncate" title={service.status}>Service is {service.status || 'inactive'}.</span>
          <Button variant="danger" size="sm" onClick={() => onRestart(service)} title="Restart this service">
            <RotateCcw size={12} /> Restart
          </Button>
          <Button variant="danger" size="sm" onClick={() => onMonitor(service)} title="View recent logs">
            View logs
          </Button>
        </div>
      )}

      {/* Address — the one thing a tile needs beyond name + health: where the
          service lives. Sits directly under the name (no mt-auto: the tile is
          content-height, not stretched, so there's no empty gap). Gateway/link
          carry their own "address" shape. */}
      <div className="mt-2">
        {service.type === 'gateway' ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-mono text-text-muted">{service.externalIP || 'N/A'}</span>
            {service.internalIP && <span className="font-mono text-text-subtle">· {service.internalIP}</span>}
          </div>
        ) : service.type === 'link' ? (
          <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent hover:underline break-all">
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
                <span key={d} className="inline-flex items-center gap-1.5 text-xs font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded-chip">
                  {looksLikeDomain && <DomainHealthDot domain={bareDomain} />}
                  <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">{d}</a>
                </span>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-text-subtle">No public address</span>
        )}
      </div>
    </Card>
  );
}
