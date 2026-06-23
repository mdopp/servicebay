'use client';

// V4 Update: Use Digital Twin data
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { EnrichedContainer } from '@servicebay/api-client';
import { Card, DataTable, type Column } from '@/components/ui';

interface ContainerItem extends Partial<EnrichedContainer> {
  // Allow partial for legacy passed props, but prefer EnrichedContainer shape
  nodeName?: string;
}

interface ContainerListProps {
  containers?: ContainerItem[];
}

const CONNECT_TIMEOUT_MS = 15_000;

function names(c: ContainerItem): string {
  return Array.isArray(c.names) ? c.names.join(', ') : (c.names ?? '');
}

// Calm, consistent columns on the shared DataTable primitive (#2078). Replaces
// the old "bunte Tabelle" — Node purple, ID blue, Image green, Names orange —
// with one quiet surface; only the clickable Domains keep an accent colour.
const columns: Column<ContainerItem>[] = [
  { key: 'node', header: 'Node', cell: c => c.nodeName ?? '-' },
  {
    key: 'id',
    header: 'ID',
    className: 'font-mono text-text-muted',
    cell: c => <span title={c.id}>{c.id?.substring(0, 12)}</span>,
  },
  {
    key: 'image',
    header: 'Image',
    className: 'max-w-[200px]',
    cell: c => <span className="block truncate" title={c.image}>{c.image}</span>,
  },
  { key: 'state', header: 'State', cell: c => c.state },
  { key: 'status', header: 'Status', cell: c => c.status },
  {
    key: 'domains',
    header: 'Domains',
    cell: c =>
      c.verifiedDomains && c.verifiedDomains.length > 0 ? (
        <div className="flex flex-wrap gap-space-1">
          {c.verifiedDomains.map(d => (
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
      ) : (
        <span className="text-text-subtle">-</span>
      ),
  },
  {
    key: 'names',
    header: 'Names',
    className: 'max-w-[200px]',
    cell: c => <span className="block truncate" title={names(c)}>{names(c)}</span>,
  },
];

export default function ContainerList({ containers }: ContainerListProps = {}) {
  const { data: twin } = useDigitalTwin();
  const [slowConnect, setSlowConnect] = useState(false);

  useEffect(() => {
    if (containers || twin) return;
    const t = setTimeout(() => setSlowConnect(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [containers, twin]);

  const allContainers = useMemo((): ContainerItem[] => {
     if (containers) return containers;
     if (!twin) return [];
     const list: ContainerItem[] = [];
     Object.entries(twin.nodes).forEach(([nodeName, nodeData]) => {
         nodeData.containers.forEach(c => {
             list.push({ ...c, nodeName });
         });
     });
     return list;
  }, [twin, containers]);

  if (!allContainers || allContainers.length === 0) {
    const isLoading = !(containers || twin);
    return (
        <Card padding="md" className="text-text-muted italic flex items-center justify-between gap-4">
            <span>
              {!isLoading && "No running containers found."}
              {isLoading && !slowConnect && "Connecting to Digital Twin..."}
              {isLoading && slowConnect && "Still connecting to Digital Twin… check Settings → Nodes if this persists."}
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

  return (
    <DataTable
      columns={columns}
      rows={allContainers}
      rowKey={(c, index) => `${c.nodeName || 'local'}-${c.id || `fallback-${index}`}`}
      minWidthClassName="min-w-[800px]"
    />
  );
}
