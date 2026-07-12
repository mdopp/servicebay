// Settings → Knowledge (#2228, child B of the assists-editor epic #2147).
//
// Browse, view, edit, approve, and revert the assist catalog + ADRs via the
// `/api/assists/*` REST API (#2221). Master list (searchable + filterable by
// kind and source) on the left; the selected entry's rendered markdown,
// metadata, inline editor, review panel and history on the right (AssistDetail).

'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2, Search } from 'lucide-react';
import { Badge, Card } from '@/components/ui';
import { ASSIST_KINDS, type AssistKind } from '../knowledge/validation';
import { useKnowledge } from '../knowledge/useKnowledge';
import AssistDetail from '../knowledge/AssistDetail';
import type { AssistSummary } from '../knowledge/types';

type KindFilter = AssistKind | 'all';
type SourceFilter = 'all' | 'Built-in' | 'Local';

export default function KnowledgeSection() {
  const api = useKnowledge();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void api.loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () => filterAssists(api.assists, query, kind, source),
    [api.assists, query, kind, source],
  );

  const selected = api.assists.find(a => a.id === selectedId) ?? null;
  const pendingCount = (id: string) =>
    api.approvals.filter(a => a.payload?.assistId === id && a.status === 'pending').length;

  if (api.loading && api.assists.length === 0) return <LoadingCatalog />;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,340px)_1fr] gap-4">
      <div className="space-y-3">
        <Filters query={query} kind={kind} source={source} onQuery={setQuery} onKind={setKind} onSource={setSource} />
        <CatalogList assists={filtered} selectedId={selectedId} pendingCount={pendingCount} onSelect={setSelectedId} />
      </div>
      <div>
        {selected ? (
          <AssistDetail summary={selected} approvals={api.approvals} api={api} />
        ) : (
          <EmptyDetail />
        )}
      </div>
    </div>
  );
}

function LoadingCatalog() {
  return (
    <p className="text-sm text-text-muted">
      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
      Loading knowledge catalog…
    </p>
  );
}

export function filterAssists(
  assists: AssistSummary[],
  query: string,
  kind: KindFilter,
  source: SourceFilter,
): AssistSummary[] {
  const q = query.trim().toLowerCase();
  return assists.filter(a => {
    if (kind !== 'all' && a.kind !== kind) return false;
    if (source !== 'all' && a.source !== source) return false;
    if (!q) return true;
    const hay = [a.id, a.title, a.whenToUse, a.kind, a.tags.join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function Filters({
  query,
  kind,
  source,
  onQuery,
  onKind,
  onSource,
}: {
  query: string;
  kind: KindFilter;
  source: SourceFilter;
  onQuery: (v: string) => void;
  onKind: (v: KindFilter) => void;
  onSource: (v: SourceFilter) => void;
}) {
  const selectClass =
    'p-2 rounded-card border border-border bg-surface-2 text-text text-sm focus:ring-2 focus:ring-accent outline-none';
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
        <input
          type="search"
          value={query}
          onChange={e => onQuery(e.target.value)}
          placeholder="Search the catalog"
          aria-label="Search the catalog"
          className="w-full pl-8 pr-3 py-2 rounded-card border border-border bg-surface-2 text-text text-sm focus:ring-2 focus:ring-accent outline-none"
        />
      </div>
      <div className="flex gap-2">
        <select
          value={kind}
          onChange={e => onKind(e.target.value as KindFilter)}
          aria-label="Filter by kind"
          className={`${selectClass} flex-1`}
        >
          <option value="all">All kinds</option>
          {ASSIST_KINDS.map(k => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <select
          value={source}
          onChange={e => onSource(e.target.value as SourceFilter)}
          aria-label="Filter by source"
          className={`${selectClass} flex-1`}
        >
          <option value="all">All sources</option>
          <option value="Built-in">Built-in</option>
          <option value="Local">Local</option>
        </select>
      </div>
    </div>
  );
}

function CatalogList({
  assists,
  selectedId,
  pendingCount,
  onSelect,
}: {
  assists: AssistSummary[];
  selectedId: string | null;
  pendingCount: (id: string) => number;
  onSelect: (id: string) => void;
}) {
  if (assists.length === 0) {
    return <p className="text-sm text-text-muted italic px-1">No entries match.</p>;
  }
  return (
    <ul className="space-y-1 max-h-[70vh] overflow-y-auto">
      {assists.map(a => {
        const pending = pendingCount(a.id);
        const active = a.id === selectedId;
        return (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onSelect(a.id)}
              aria-current={active}
              className={`w-full text-left p-2 rounded-card border transition-colors ${
                active ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-surface-2'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text truncate flex-1">{a.title}</span>
                {pending > 0 && <Badge variant="warn">{pending}</Badge>}
                <Badge variant={a.source === 'Local' ? 'accent' : 'neutral'} className="font-mono text-[10px]">
                  {a.kind}
                </Badge>
              </div>
              <p className="text-[11px] text-text-subtle truncate mt-0.5">{a.whenToUse}</p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyDetail() {
  return (
    <Card className="h-full flex flex-col items-center justify-center text-center p-8 text-text-muted">
      <BookOpen size={32} className="mb-3 text-text-subtle" />
      <p className="text-sm">Select an entry to view its content, edit it, or review pending changes.</p>
    </Card>
  );
}
