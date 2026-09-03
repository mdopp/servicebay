'use client';

import { useRef } from 'react';
import dynamic from 'next/dynamic';
import { Eraser, RefreshCw, Terminal as TerminalIcon, X } from 'lucide-react';
import type { EnrichedContainer } from '@servicebay/api-client';
import { Button } from '@/components/ui';
import ContainerLogsPanel, { type ContainerLogsPanelData } from '@/components/ContainerLogsPanel';
import type { TerminalRef } from '@/components/Terminal';

// #2734: the right-hand container Logs / Terminal drawer existed twice —
// `ContainerList` owned one (shared by ServiceMonitor, ContainersDashboard and
// OperateContainersTab) and `ServicesDashboard` carried its own near-identical
// copy. This is that drawer, once: the caller owns "which container, which
// mode", the drawer owns the overlay, the terminal controls and the close
// affordance.

const DynamicTerminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

type ContainerDrawerMode = 'logs' | 'terminal';

/** What the drawer needs to render: the logs-panel payload plus the owning
 *  node (absent / `Local` = this box). */
export interface ContainerDrawerData extends ContainerLogsPanelData {
  nodeName?: string;
}

/** Map a (possibly partial) container twin onto the drawer's data shape — the
 *  name normalisation and the port mapping were the duplicated part. */
export function toContainerDrawerData(
  container: Partial<EnrichedContainer> & { nodeName?: string },
): ContainerDrawerData {
  const first = Array.isArray(container.names) ? container.names[0] : container.names;
  const id = container.id ?? '';
  return {
    id,
    name: (first ?? id).replace(/^\/+/, '') || id,
    nodeName: container.nodeName,
    image: container.image,
    state: container.state,
    status: container.status,
    created: container.created,
    ports: (container.ports ?? []).map(port => ({
      hostIp: port.hostIp,
      hostPort: port.hostPort,
      containerPort: port.containerPort ?? 0,
      protocol: port.protocol,
    })),
    mounts: container.mounts as ContainerLogsPanelData['mounts'],
    hideMeta: true,
  };
}

export interface ContainerDrawerProps {
  /** `null` (or a null container) keeps the drawer closed. */
  mode: ContainerDrawerMode | null;
  container: ContainerDrawerData | null;
  onClose: () => void;
}

export default function ContainerDrawer({ mode, container, onClose }: ContainerDrawerProps) {
  const terminalRef = useRef<TerminalRef>(null);

  if (!mode || !container) return null;

  const node = container.nodeName && container.nodeName !== 'Local' ? container.nodeName : 'Local';
  const terminalId = `container:${node !== 'Local' ? node : 'local'}:${container.id}`;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-5xl h-full bg-surface border-l border-border shadow-2xl animate-in slide-in-from-right-10">
        {mode === 'logs' ? (
          <ContainerLogsPanel container={container} nodeName={node} onClose={onClose} />
        ) : (
          <div className="h-full flex flex-col bg-surface">
            <div className="flex items-start justify-between px-6 py-4 border-b border-border bg-surface-2">
              <div>
                <p className="text-xs uppercase tracking-wider text-text-subtle">Terminal</p>
                <div className="flex items-center gap-3 text-text text-lg font-semibold">
                  <TerminalIcon size={18} />
                  <span>{container.name}</span>
                </div>
                <div className="mt-2 inline-flex items-center gap-2 text-xs text-text-muted">
                  <span className="uppercase tracking-wide">Node</span>
                  <span className="px-2 py-0.5 rounded-full bg-surface-2 text-text-muted border border-border">{node}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* `!h-auto !p-2` forces out size="sm"'s h-8/px-space-3 so these
                    icon buttons stay square p-2 targets (the cn() collision of
                    #2479/#2482/#2483, issue #2484). */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => terminalRef.current?.clear()}
                  className="!h-auto !p-2 rounded-full"
                  title="Clear terminal"
                >
                  <Eraser size={18} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => terminalRef.current?.reconnect()}
                  className="!h-auto !p-2 rounded-full"
                  title="Reconnect"
                >
                  <RefreshCw size={18} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  className="!h-auto !p-2 rounded-full"
                  title="Close"
                >
                  <X size={18} />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <DynamicTerminal ref={terminalRef} id={terminalId} showControls={false} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
