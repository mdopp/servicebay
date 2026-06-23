'use client';

import { useRouter } from 'next/navigation';
import { AlertCircle, Crosshair, Download, RotateCcw } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { networkFocusHref } from '@/components/networkFocus';
import { DomainHealthDot } from '@/components/DomainHealthDot';
import { Badge, Button, StatusDot, type StatusState } from '@/components/ui';

// #2067: the Services overview reads as a list on desktop, not a card grid
// (operator feedback on 4.138.0). ServiceRow is the desktop list-row twin of
// ServiceCard: same data (ServiceViewModel), same action callbacks, same lean
// content (status dot + name + badges + address + ServiceActionBar) — just laid
// out as one tight table-like row instead of a card. ServiceCard stays for the
// mobile single-column stack; the dashboard renders one or the other per
// breakpoint (`hidden md:flex` vs `md:hidden`).
//
// #2079: migrated onto the design-system primitives (StatusDot/Badge/Button) +
// semantic tokens — no raw green-500/blue-600/gray-* literals.

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

/** Map a service's live state to the StatusDot's four states (mirrors
 *  ServiceCard): systemd transitional states + the crash-loop "auto-restart"
 *  subState are warn, active is ok, else fail. */
export function serviceDotState(service: ServiceViewModel): {
  state: StatusState;
  title: string;
  pulse: boolean;
} {
  const transitional =
    ['activating', 'reloading', 'deactivating'].includes(service.activeState ?? '') ||
    service.subState === 'auto-restart';
  if (transitional) {
    return {
      state: 'warn',
      title: `${service.activeState ?? 'transitioning'}${service.subState ? ` (${service.subState})` : ''}`,
      pulse: true,
    };
  }
  return { state: service.active ? 'ok' : 'fail', title: service.status ?? '', pulse: false };
}

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
  const router = useRouter();
  const dot = serviceDotState(service);
  const showFailedNudge = !service.active && service.type !== 'gateway' && service.type !== 'link';
  // #2108: per-service "focus in network map" jump. Only managed services have
  // a `service-<name>` node to centre on — gateway/link nodes are out of scope.
  const showNetworkFocus = service.type !== 'gateway' && service.type !== 'link';

  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 transition-colors min-w-0">
      {/* Status dot */}
      <StatusDot
        state={dot.state}
        label={dot.title}
        title={dot.title}
        className={`shrink-0 ${dot.pulse ? 'animate-pulse' : ''}`}
      />

      {/* Name + badges */}
      <div className="flex items-center gap-2 min-w-0 basis-1/3 shrink-0">
        <h3
          className="font-semibold text-sm text-text truncate"
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

      {/* Address — same shapes as ServiceCard (gateway IPs / link URL /
          verified domains with health dots / "No public address"). */}
      <div className="flex-1 min-w-0">
        {service.type === 'gateway' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-mono text-text-muted">{service.externalIP || 'N/A'}</span>
            {service.internalIP && <span className="font-mono text-text-subtle">· {service.internalIP}</span>}
          </div>
        ) : service.type === 'link' ? (
          <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-accent hover:underline break-all">
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

      {/* Failed-state nudge — compact inline restart/logs, mirrors ServiceCard. */}
      {showFailedNudge && (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="hidden xl:inline-flex items-center gap-1 text-xs text-status-fail" title={service.status}>
            <AlertCircle size={12} className="shrink-0" /> {service.status || 'inactive'}
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onRestart(service)}
            title="Restart this service"
          >
            <RotateCcw size={12} /> Restart
          </Button>
        </div>
      )}

      {/* #2108: focus this service in the Network Map. */}
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
