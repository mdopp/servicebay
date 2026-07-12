// The right-hand detail pane of the Knowledge editor (#2228): view the rendered
// markdown + metadata, edit inline (with frontmatter + secret validation),
// submit a proposal, review pending proposals (approve/reject), and browse the
// version history with a revert action.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertTriangle, Check, History, Loader2, Pencil, RotateCcw, X } from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui';
import { validateProposal } from './validation';
import type { AssistApproval, AssistSummary, HistoryEntry } from './types';
import type { useKnowledge } from './useKnowledge';

type Api = ReturnType<typeof useKnowledge>;

interface AssistDetailProps {
  summary: AssistSummary;
  approvals: AssistApproval[];
  api: Api;
}

export default function AssistDetail({ summary, approvals, api }: AssistDetailProps) {
  const [content, setContent] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [editing, setEditing] = useState(false);

  const reload = useCallback(async () => {
    const [nextContent, nextHistory] = await Promise.all([
      api.loadContent(summary.id),
      api.loadHistory(summary.id),
    ]);
    setContent(nextContent);
    setHistory(nextHistory);
  }, [api, summary.id]);

  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps --
     Reset the editor + async-load content on entry change; setEditing is a
     one-shot reset, the load itself is async (below), and depending on the
     summary id alone is intentional (reload is id-stable). */
  useEffect(() => {
    setEditing(false);
    void reload();
  }, [summary.id]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const pending = approvals.filter(a => a.payload?.assistId === summary.id && a.status === 'pending');
  const lastEdited = history.length > 0 ? history[history.length - 1] : null;

  return (
    <Card padding="none" className="overflow-hidden">
      <DetailHeader summary={summary} lastEdited={lastEdited} editing={editing} onEdit={() => setEditing(true)} />
      <div className="p-space-5 space-y-6">
        {pending.length > 0 && (
          <ReviewPanel assistId={summary.id} pending={pending} api={api} onResolved={reload} />
        )}
        {editing ? (
          <ProposalEditor
            initial={content ?? ''}
            assistId={summary.id}
            api={api}
            onDone={() => { setEditing(false); void reload(); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <RenderedBody content={content} />
        )}
        <HistoryTimeline assistId={summary.id} history={history} api={api} onReverted={reload} />
      </div>
    </Card>
  );
}

function DetailHeader({
  summary,
  lastEdited,
  editing,
  onEdit,
}: {
  summary: AssistSummary;
  lastEdited: HistoryEntry | null;
  editing: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-start gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-text flex items-center gap-space-2 flex-wrap">
          {summary.title}
          <Badge variant="neutral" className="font-mono">{summary.kind}</Badge>
          <Badge variant={summary.source === 'Local' ? 'accent' : 'info'}>{summary.source}</Badge>
        </h3>
        <p className="text-xs text-text-muted mt-1">{summary.whenToUse}</p>
        <div className="mt-2 flex items-center gap-space-2 flex-wrap">
          {summary.tags.map(tag => (
            <span key={tag} className="text-[11px] text-text-subtle font-mono">#{tag}</span>
          ))}
        </div>
        {lastEdited && (
          <p className="text-[11px] text-text-subtle mt-1">
            Last modified v{lastEdited.version} · {lastEdited.author} · {new Date(lastEdited.timestamp).toLocaleString()}
          </p>
        )}
      </div>
      {!editing && (
        <Button variant="secondary" size="sm" onClick={onEdit} className="shrink-0">
          <Pencil size={14} /> Edit
        </Button>
      )}
    </div>
  );
}

function RenderedBody({ content }: { content: string | null }) {
  if (content === null) {
    return (
      <p className="text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading…
      </p>
    );
  }
  return (
    <div className="prose dark:prose-invert prose-sm max-w-none">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}

function ProposalEditor({
  initial,
  assistId,
  api,
  onDone,
  onCancel,
}: {
  initial: string;
  assistId: string;
  api: Api;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const validation = useMemo(() => validateProposal(body), [body]);

  const submit = async () => {
    if (!validation.ok) return;
    setBusy(true);
    const ok = await api.propose(assistId, body, message.trim() || `Edit ${assistId}`);
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <div className="space-y-3">
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        spellCheck={false}
        rows={20}
        aria-label="Assist markdown source"
        className="w-full p-3 rounded-card border border-border bg-surface-2 text-text font-mono text-xs focus:ring-2 focus:ring-accent outline-none"
        placeholder="---&#10;title: …&#10;whenToUse: …&#10;kind: guide&#10;---&#10;body…"
      />
      {!validation.ok && <ValidationBanner error={validation.error} />}
      <input
        type="text"
        value={message}
        onChange={e => setMessage(e.target.value)}
        className="w-full p-2 rounded-card border border-border bg-surface-2 text-text text-sm focus:ring-2 focus:ring-accent outline-none"
        placeholder="Change summary (commit message)"
      />
      <div className="flex items-center gap-2">
        <Button onClick={() => void submit()} disabled={!validation.ok || busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Submit proposal
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          <X size={14} /> Cancel
        </Button>
      </div>
    </div>
  );
}

function ValidationBanner({ error }: { error?: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 text-xs text-status-fail bg-status-fail/10 rounded-card p-space-3"
    >
      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
      <span>{error}</span>
    </div>
  );
}

function ReviewPanel({
  assistId,
  pending,
  api,
  onResolved,
}: {
  assistId: string;
  pending: AssistApproval[];
  api: Api;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const act = async (requestId: string, decision: 'approve' | 'reject') => {
    setBusy(true);
    const ok = await api.resolve(assistId, requestId, decision);
    setBusy(false);
    if (ok) onResolved();
  };

  return (
    <div className="space-y-2">
      <Badge variant="warn">{pending.length} pending proposal{pending.length === 1 ? '' : 's'}</Badge>
      {pending.map(req => (
        <Card key={req.id} padding="none">
          <div className="p-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text">
                {req.payload?.revertOf ? `Revert to v${req.payload.revertOf}` : 'Edit proposal'}
              </span>
              {req.description && <p className="mt-1 text-xs text-text-muted">{req.description}</p>}
              <span className="text-[11px] text-text-subtle">{new Date(req.created_at).toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(req.id, 'approve')}>
                <Check size={14} /> Approve
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void act(req.id, 'reject')}>
                <X size={14} /> Reject
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function HistoryTimeline({
  assistId,
  history,
  api,
  onReverted,
}: {
  assistId: string;
  history: HistoryEntry[];
  api: Api;
  onReverted: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  const doRevert = async (version: number) => {
    setBusy(version);
    const ok = await api.revert(assistId, version);
    setBusy(null);
    if (ok) onReverted();
  };

  return (
    <div className="border-t border-border pt-4">
      <h4 className="text-sm font-semibold text-text flex items-center gap-2 mb-2">
        <History size={14} /> History
      </h4>
      {history.length === 0 ? (
        <p className="text-xs text-text-muted italic">No edits yet — this entry is the shipped built-in.</p>
      ) : (
        <ul className="space-y-1">
          {[...history].reverse().map(entry => (
            <HistoryRow key={entry.version} entry={entry} busy={busy} onRevert={v => void doRevert(v)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  busy,
  onRevert,
}: {
  entry: HistoryEntry;
  busy: number | null;
  onRevert: (version: number) => void;
}) {
  return (
    <li className="flex items-center gap-3 text-xs py-1">
      <Badge variant="neutral" className="font-mono">v{entry.version}</Badge>
      <span className="flex-1 min-w-0 text-text-muted truncate">
        {entry.message} · {entry.author} · {new Date(entry.timestamp).toLocaleString()}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy !== null}
        onClick={() => onRevert(entry.version)}
        title={`Request a revert to version ${entry.version}`}
      >
        {busy === entry.version ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        Revert
      </Button>
    </li>
  );
}
