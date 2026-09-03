'use client';

import { useRouter } from 'next/navigation';
import { AlertCircle, Crosshair, Download, RotateCcw } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { networkFocusHref } from '@/components/networkFocus';
import { DomainHealthDot } from '@/components/DomainHealthDot';
import { Badge, Button, Card, StatusDot, type StatusState } from '@/components/ui';

// #2734: ServiceCard (mobile card) and ServiceRow (desktop list row) were two
// files with identical imports, identical props, identical badges and identical
// address rendering — ServiceCard even imported `serviceDotState` *from*
// ServiceRow. They differ only in the outer wrapper (grid card vs flex row) and
// two type scales, so they are one component with a `layout` prop.
//
// IA redesign (spec §4.1 "a tile is a service is a shared purpose"): the LIST
// tile is intentionally lean — status + name + address + service-level actions.
// Per-port links, volume counts and attached-container rows live ONLY on the
// per-service Operate page (`/services/[name]`), so the home list stays a clean
// "one dot = one honest health state" list.
//
// #2079: both layouts sit on the design-system primitives (StatusDot / Badge /
// Button / Card) + semantic tokens — no raw green-500/blue-600/gray-* literals.

/** `card` = the mobile single-column stack; `row` = the desktop dense list. */
export type ServiceTileLayout = 'card' | 'row';

export interface ServiceTileProps {
  service: ServiceViewModel;
  /** Grid card (mobile) or dense list row (desktop). Defaults to `card`. */
  layout?: ServiceTileLayout;
  /** Domains NPM is currently serving over HTTPS — picks the scheme for the
   *  per-domain link so LAN-only services don't TLS-error on click. */
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

/** Map a service's live state to the StatusDot's four states: systemd
 *  transitional states + the crash-loop "auto-restart" subState are warn,
 *  active is ok, else fail. */
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

/** Gateway/link "services" have their own lifecycle and no `service-<name>`
 *  node on the network map, so they get neither the restart nudge nor the
 *  network-focus jump (#2108). */
function isManaged(service: ServiceViewModel): boolean {
  return service.type !== 'gateway' && service.type !== 'link';
}

/** Node / kind / role badges + the #1860 image-update affordance. Identical in
 *  both layouts; only the surrounding container differs. */
function ServiceTileBadges({
  service,
  imageUpdateAvailable,
  onUpdate,
}: Pick<ServiceTileProps, 'service' | 'imageUpdateAvailable' | 'onUpdate'>) {
  return (
    <>
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
    </>
  );
}

/** Where the service lives: gateway IPs / link URL / verified domains with
 *  health dots / "No public address". The card runs one type scale larger. */
function ServiceTileAddress({
  service,
  httpsDomains,
  layout,
}: Pick<ServiceTileProps, 'service' | 'httpsDomains'> & { layout: ServiceTileLayout }) {
  const scale = layout === 'card' ? 'text-sm' : 'text-xs';
  if (service.type === 'gateway') {
    return (
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${scale}`}>
        <span className="font-mono text-text-muted">{service.externalIP || 'N/A'}</span>
        {service.internalIP && <span className="font-mono text-text-subtle">· {service.internalIP}</span>}
      </div>
    );
  }
  if (service.type === 'link') {
    return (
      <a
        href={service.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${scale} font-medium text-accent hover:underline break-all`}
      >
        {service.url}
      </a>
    );
  }
  if (!service.verifiedDomains || service.verifiedDomains.length === 0) {
    return <span className="text-xs text-text-subtle">No public address</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {service.verifiedDomains.map(d => {
        // Strip scheme + path so the health-check key (registered against the
        // bare domain) matches the digital twin. Pick the scheme NPM actually
        // serves so LAN-only domains don't TLS-error on click.
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
  );
}

export default function ServiceTile({
  service,
  layout = 'card',
  httpsDomains,
  imageUpdateAvailable,
  onUpdate,
  onMonitor,
  onEdit,
  onActions,
  onEditLink,
  onDelete,
  onRestart,
}: ServiceTileProps) {
  const router = useRouter();
  const dot = serviceDotState(service);
  const managed = isManaged(service);
  const showFailedNudge = !service.active && managed;

  const statusDot = (
    <StatusDot
      state={dot.state}
      label={dot.title}
      title={dot.title}
      className={`${layout === 'card' ? 'mt-1.5 ' : ''}shrink-0 ${dot.pulse ? 'animate-pulse' : ''}`}
    />
  );

  const name = (
    <h3
      className={`${layout === 'card' ? 'font-bold text-lg' : 'font-semibold text-sm'} text-text truncate`}
      title={service.name}
      data-testid={`service-name-${service.displayName}`}
    >
      {service.displayName}
    </h3>
  );

  const badges = (
    <ServiceTileBadges service={service} imageUpdateAvailable={imageUpdateAvailable} onUpdate={onUpdate} />
  );

  const address = <ServiceTileAddress service={service} httpsDomains={httpsDomains} layout={layout} />;

  // #2108: per-service "focus in network map" jump (managed services only).
  const networkFocus = managed && (
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
  );

  const actionBar = (
    <ServiceActionBar
      service={service}
      className={layout === 'row' ? 'shrink-0' : undefined}
      onMonitor={onMonitor}
      onEdit={onEdit}
      onActions={onActions}
      onEditLink={onEditLink}
      onDelete={onDelete}
    />
  );

  if (layout === 'row') {
    return (
      <div className="group flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 transition-colors min-w-0">
        {statusDot}
        <div className="flex items-center gap-2 min-w-0 basis-1/3 shrink-0">
          {name}
          {badges}
        </div>
        <div className="flex-1 min-w-0">{address}</div>

        {/* Failed-state nudge — compact inline restart, so a dead service is one
            click from recovery without a dig through Actions. */}
        {showFailedNudge && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="hidden xl:inline-flex items-center gap-1 text-xs text-status-fail" title={service.status}>
              <AlertCircle size={12} className="shrink-0" /> {service.status || 'inactive'}
            </span>
            <Button variant="danger" size="sm" onClick={() => onRestart(service)} title="Restart this service">
              <RotateCcw size={12} /> Restart
            </Button>
          </div>
        )}

        {networkFocus}
        {actionBar}
      </div>
    );
  }

  return (
    <Card padding="md" className="group self-start hover:shadow-md transition-all duration-200 relative overflow-hidden min-w-0">
      <div className="flex items-start gap-4 justify-between mb-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {statusDot}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              {name}
              {badges}
            </div>
          </div>
        </div>
        {networkFocus}
        {actionBar}
      </div>

      {/* Failed-state nudge: the card has room for the status text plus a
          one-click restart AND a jump to the logs. */}
      {showFailedNudge && (
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

      {/* Address sits directly under the name (no mt-auto: the tile is
          content-height, not stretched, so there's no empty gap). */}
      <div className="mt-2">{address}</div>
    </Card>
  );
}
