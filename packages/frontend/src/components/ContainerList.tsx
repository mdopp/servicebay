'use client';

// Canonical container-list component (#2367). The Status → Containers view was
// the richer of the two container lists (card rows + per-container Logs /
// Terminal / Actions drawer); this is that view extracted into one shared
// component so Service → Containers (OperateContainersTab) renders the identical
// layout and gains the "open terminal" action instead of a divergent DataTable.
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, Eraser, MoreVertical, RefreshCw, Terminal as TerminalIcon, X } from 'lucide-react';
import type { EnrichedContainer } from '@servicebay/api-client';
import { Card, SectionHeading, StatusDot } from '@/components/ui';
import { useContainerActions } from '@/hooks/useContainerActions';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import ContainerLogsPanel, { type ContainerLogsPanelData } from '@/components/ContainerLogsPanel';
import type { TerminalRef } from '@/components/Terminal';

const DynamicTerminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

const CONNECT_TIMEOUT_MS = 15_000;

export interface ContainerListItem extends Partial<EnrichedContainer> {
  nodeName?: string;
  // Owning service/bundle badge (Status view). Optional so callers that don't
  // resolve parentage (Service view) simply omit the badge.
  parent?: { type: 'service' | 'bundle'; name: string };
}

export interface ContainerListGroup {
  id: string;
  label: string;
  containers: ContainerListItem[];
}

interface ContainerListProps {
  /** Explicit container list (Service view, ServiceMonitor). */
  containers?: ContainerListItem[];
  /** Stack-grouped rendering (Status view). Takes precedence over `containers`. */
  groups?: ContainerListGroup[];
  /** Render the owning service/bundle badge on each row (Status view). */
  showParentBadge?: boolean;
  /**
   * Open a drawer for a container id (Status view URL params; the service
   * Operate page's "Logs" quick action). `nonce` is part of the
   * already-handled key (#2391), so asking for the *same* drawer again — a
   * second click on Logs after the user closed it — re-opens it instead of
   * being swallowed by the one-shot guard.
   */
  initialDrawer?: { containerId: string; mode: 'logs' | 'terminal'; nonce?: number } | null;
}

function primaryName(c: ContainerListItem): string {
  const first = Array.isArray(c.names) ? c.names[0] : c.names;
  return (first ?? c.id ?? '').replace(/^\/+/, '');
}

export default function ContainerList({ containers, groups, showParentBadge, initialDrawer }: ContainerListProps = {}) {
  const { data: twin } = useDigitalTwin();
  const [slowConnect, setSlowConnect] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'logs' | 'terminal' | null>(null);
  const [drawerContainer, setDrawerContainer] = useState<ContainerListItem | null>(null);
  const [handledInitial, setHandledInitial] = useState<string | null>(null);
  const terminalRef = useRef<TerminalRef>(null);

  const explicit = groups !== undefined || containers !== undefined;

  useEffect(() => {
    if (explicit || twin) return;
    const t = setTimeout(() => setSlowConnect(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [explicit, twin]);

  // The flat, ordered list backing lookups + the ungrouped render path.
  const renderGroups = useMemo((): ContainerListGroup[] => {
    if (groups) return groups;
    let list: ContainerListItem[];
    if (containers) {
      list = containers;
    } else if (twin) {
      list = [];
      Object.entries(twin.nodes).forEach(([nodeName, nodeData]) => {
        nodeData.containers.forEach(c => list.push({ ...c, nodeName }));
      });
    } else {
      list = [];
    }
    return [{ id: '__all__', label: '', containers: list }];
  }, [groups, containers, twin]);

  const allContainers = useMemo(
    () => renderGroups.flatMap(g => g.containers),
    [renderGroups],
  );

  const closeDrawer = useCallback(() => {
    setDrawerMode(null);
    setDrawerContainer(null);
  }, []);

  const {
    openActions: openContainerActions,
    closeActions: closeContainerActions,
    overlay: containerActionsOverlay,
    isOpen: containerActionsOpen,
  } = useContainerActions();

  useEscapeKey(closeContainerActions, containerActionsOpen, true);
  const shouldCloseDrawerOnEscape = Boolean(drawerMode);
  useEscapeKey(closeDrawer, shouldCloseDrawerOnEscape, true);

  // Open a drawer from a caller-supplied container id (Status URL params).
  useEffect(() => {
    if (!initialDrawer || !allContainers.length) return;
    const requestKey = `${initialDrawer.nonce ?? 0}:${initialDrawer.mode}:${initialDrawer.containerId}`;
    if (handledInitial === requestKey) return;
    const found = allContainers.find(
      c => c.id === initialDrawer.containerId || c.id?.startsWith(initialDrawer.containerId),
    );
    if (found) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot request→state sync, guarded by handledInitial
      setDrawerContainer(found);
      setDrawerMode(initialDrawer.mode);
      setHandledInitial(requestKey);
    }
  }, [initialDrawer, allContainers, handledInitial]);

  const openLogs = useCallback((c: ContainerListItem) => {
    setDrawerContainer(c);
    setDrawerMode('logs');
  }, []);

  const openTerminal = useCallback((c: ContainerListItem) => {
    setDrawerContainer(c);
    setDrawerMode('terminal');
  }, []);

  const openActions = useCallback((c: ContainerListItem) => {
    openContainerActions({
      id: c.id ?? '',
      name: primaryName(c),
      nodeName: c.nodeName,
    });
  }, [openContainerActions]);

  const getVisiblePorts = (c: ContainerListItem) => {
    if (!c.ports || c.ports.length === 0) return [];
    if (c.podName && !c.isInfra) return [];
    return c.ports;
  };

  if (allContainers.length === 0) {
    const isLoading = !explicit && !twin;
    return (
      <Card padding="md" className="text-text-muted italic flex items-center justify-between gap-4">
        <span>
          {!isLoading && 'No running containers found.'}
          {isLoading && !slowConnect && 'Connecting to Digital Twin...'}
          {isLoading && slowConnect && 'Still connecting to Digital Twin… check Settings → Nodes if this persists.'}
        </span>
        {isLoading && slowConnect && (
          <button
            type="button"
            onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-surface-2 hover:bg-surface-muted text-text rounded transition-colors not-italic"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        )}
      </Card>
    );
  }

  const renderRow = (c: ContainerListItem, index: number) => {
    const ports = getVisiblePorts(c);
    const domains = c.verifiedDomains ?? [];
    return (
      <div
        key={`${c.nodeName || 'local'}-${c.id || `fallback-${index}`}`}
        className="p-space-3 hover:bg-surface-2 transition-colors"
      >
        <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <StatusDot
              state={c.state === 'running' ? 'ok' : 'unknown'}
              label={c.state === 'running' ? 'Running' : (c.state ?? 'unknown')}
            />
            <div>
              <div className="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
                {primaryName(c)}
                {c.nodeName && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-surface-2 text-accent border border-border">
                    {c.nodeName}
                  </span>
                )}
                {showParentBadge && c.parent && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[11px] font-semibold border truncate max-w-[180px] bg-surface-2 text-text-muted border-border"
                    title={`${c.parent.type === 'service' ? 'Service' : 'Bundle'}: ${c.parent.name}`}
                  >
                    <span className="uppercase tracking-wide mr-1 text-[10px] opacity-80">
                      {c.parent.type === 'service' ? 'Svc' : 'Bundle'}
                    </span>
                    <span className="font-mono text-[10px]">{c.parent.name}</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted">{c.status}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => openLogs(c)}
              className="p-1.5 text-text-muted hover:text-accent hover:bg-surface-2 rounded"
              title="Logs & Info"
            >
              <Activity size={18} />
            </button>
            <button
              onClick={() => openTerminal(c)}
              className="p-1.5 text-text-muted hover:text-accent hover:bg-surface-2 rounded"
              title="Terminal"
            >
              <TerminalIcon size={18} />
            </button>
            <button
              onClick={() => openActions(c)}
              className="p-1.5 text-text-muted hover:text-accent hover:bg-surface-2 rounded"
              title="Actions"
            >
              <MoreVertical size={18} />
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs sm:text-sm text-text-muted">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-text-subtle">Image</p>
            <p className="break-all">{c.image}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-text-subtle">Network</p>
            {c.isHostNetwork ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-accent bg-surface-2 px-2 py-0.5 rounded">
                Host Network
              </span>
            ) : (
              <span>{(c.networks && c.networks.length > 0 ? c.networks[0] : null) || 'Default'}</span>
            )}
          </div>
          {domains.length > 0 && (
            <div className="md:col-span-2">
              <p className="text-[11px] uppercase tracking-wide text-text-subtle">Domains</p>
              <div className="flex flex-wrap gap-space-1">
                {domains.map(d => (
                  <a
                    key={d}
                    href={`https://${d}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline"
                  >
                    {d}
                  </a>
                ))}
              </div>
            </div>
          )}
          {ports.length > 0 && (
            <div className="md:col-span-2">
              <p className="text-[11px] uppercase tracking-wide text-text-subtle">Ports</p>
              <div className="flex flex-wrap gap-1.5">
                {ports.map((p, i) => {
                  const protocol = (p.protocol || 'tcp').toLowerCase();
                  const display = p.hostPort && p.hostPort !== p.containerPort
                    ? `${p.hostPort}:${p.containerPort}/${protocol}`
                    : p.hostPort
                      ? `${p.hostPort}/${protocol}`
                      : `${p.containerPort}/${protocol}`;
                  return (
                    <span key={`${display}-${i}`} className="bg-surface-2 px-2 py-0.5 rounded text-[11px] font-mono border border-border text-text-muted">
                      {display}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const grouped = groups !== undefined;
  const drawerNode = drawerContainer?.nodeName && drawerContainer.nodeName !== 'Local'
    ? drawerContainer.nodeName
    : drawerContainer
      ? 'Local'
      : null;

  const logsPanelData: ContainerLogsPanelData | null = drawerContainer
    ? {
        id: drawerContainer.id ?? '',
        name: primaryName(drawerContainer),
        image: drawerContainer.image,
        state: drawerContainer.state,
        status: drawerContainer.status,
        created: drawerContainer.created,
        ports: (drawerContainer.ports ?? []).map(p => ({
          hostIp: p.hostIp,
          hostPort: p.hostPort,
          containerPort: p.containerPort ?? 0,
          protocol: p.protocol,
        })),
        mounts: drawerContainer.mounts as ContainerLogsPanelData['mounts'],
        hideMeta: true,
      }
    : null;

  return (
    <>
      {grouped ? (
        <div className="space-y-8" data-testid="containers-stack-groups">
          {renderGroups.map(group => (
            <section key={group.id} className="space-y-3" data-testid={`container-group-${group.id}`}>
              <SectionHeading
                description={`${group.containers.length} container${group.containers.length === 1 ? '' : 's'}`}
              >
                {group.label}
              </SectionHeading>
              <Card padding="none" className="divide-y divide-border overflow-hidden">
                {group.containers.map((c, i) => renderRow(c, i))}
              </Card>
            </section>
          ))}
        </div>
      ) : (
        <Card padding="none" className="divide-y divide-border overflow-hidden">
          {allContainers.map((c, i) => renderRow(c, i))}
        </Card>
      )}

      {containerActionsOverlay}

      {drawerMode && drawerContainer && (
        <div className="fixed inset-0 z-50 flex justify-end bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-5xl h-full bg-surface border-l border-border shadow-2xl animate-in slide-in-from-right-10">
            {drawerMode === 'logs' && logsPanelData ? (
              <ContainerLogsPanel
                container={logsPanelData}
                nodeName={drawerNode ?? undefined}
                onClose={closeDrawer}
              />
            ) : (
              <div className="h-full flex flex-col bg-surface">
                <div className="flex items-start justify-between px-6 py-4 border-b border-border bg-surface-2">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-text-subtle">Terminal</p>
                    <div className="flex items-center gap-3 text-text text-lg font-semibold">
                      <TerminalIcon size={18} />
                      <span>{primaryName(drawerContainer)}</span>
                    </div>
                    {drawerNode && (
                      <div className="mt-2 inline-flex items-center gap-2 text-xs text-text-muted">
                        <span className="uppercase tracking-wide">Node</span>
                        <span className="px-2 py-0.5 rounded-full bg-surface-2 text-text-muted border border-border">{drawerNode}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => terminalRef.current?.clear()}
                      className="p-2 rounded-full text-text-muted hover:text-text hover:bg-surface-2"
                      title="Clear terminal"
                    >
                      <Eraser size={18} />
                    </button>
                    <button
                      onClick={() => terminalRef.current?.reconnect()}
                      className="p-2 rounded-full text-text-muted hover:text-text hover:bg-surface-2"
                      title="Reconnect"
                    >
                      <RefreshCw size={18} />
                    </button>
                    <button
                      onClick={closeDrawer}
                      className="p-2 rounded-full text-text-muted hover:text-text hover:bg-surface-2"
                      title="Close"
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  <DynamicTerminal
                    ref={terminalRef}
                    id={`container:${(drawerNode && drawerNode !== 'Local' ? drawerNode : 'local')}:${drawerContainer.id}`}
                    showControls={false}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
