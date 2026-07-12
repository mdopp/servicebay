// Data layer for the Knowledge (assists) editor (#2228) — all calls against the
// `/api/assists/*` REST API shipped in #2221 plus the generic `/api/approvals`
// list (assist-edit requests are surfaced there). Kept out of the component so
// the view stays declarative.

'use client';

import { useCallback, useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import type { AssistApproval, AssistSummary, HistoryEntry } from './types';

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error ?? `HTTP ${res.status}`;
}

export function useKnowledge() {
  const { addToast } = useToast();
  const [assists, setAssists] = useState<AssistSummary[]>([]);
  const [approvals, setApprovals] = useState<AssistApproval[]>([]);
  const [loading, setLoading] = useState(true);

  /** Load the catalog list (optionally filtered by free-text query + kind). */
  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, apprRes] = await Promise.all([
        fetch('/api/assists'),
        fetch('/api/approvals'),
      ]);
      if (listRes.ok) {
        const data = await listRes.json();
        setAssists(Array.isArray(data.assists) ? data.assists : []);
      } else {
        addToast('error', 'Could not load the knowledge catalog', await readError(listRes));
      }
      if (apprRes.ok) {
        const data = await apprRes.json();
        const all: AssistApproval[] = Array.isArray(data.approvals) ? data.approvals : [];
        setApprovals(all.filter(a => a.payload?.kind === 'assist-edit'));
      }
    } catch (e) {
      addToast('error', 'Could not load the knowledge catalog', e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  /** Fetch the raw markdown (frontmatter + body) of one entry. */
  const loadContent = useCallback(async (id: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/assists/${encodeURIComponent(id)}`);
      if (res.ok) {
        const data = await res.json();
        return typeof data.content === 'string' ? data.content : '';
      }
      addToast('error', 'Could not load entry', await readError(res));
    } catch (e) {
      addToast('error', 'Could not load entry', e instanceof Error ? e.message : 'Network error');
    }
    return null;
  }, [addToast]);

  /** Fetch the ordered edit history for an entry. */
  const loadHistory = useCallback(async (id: string): Promise<HistoryEntry[]> => {
    try {
      const res = await fetch(`/api/assists/${encodeURIComponent(id)}/history`);
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data.history) ? data.history : [];
      }
    } catch {
      /* non-fatal — history is auxiliary */
    }
    return [];
  }, []);

  /** Submit an edit proposal. Surfaces the backend 400/422 (frontmatter/secret) cleanly. */
  const propose = useCallback(async (id: string, content: string, message: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/assists/${encodeURIComponent(id)}/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, message }),
      });
      if (res.ok) {
        addToast('success', 'Proposal submitted', 'An admin must approve it before it takes effect.');
        await loadList();
        return true;
      }
      addToast('error', 'Proposal rejected', await readError(res));
    } catch (e) {
      addToast('error', 'Could not submit proposal', e instanceof Error ? e.message : 'Network error');
    }
    return false;
  }, [addToast, loadList]);

  /** Approve or reject a pending assist-edit request. */
  const resolve = useCallback(async (
    assistId: string,
    requestId: string,
    decision: 'approve' | 'reject',
  ): Promise<boolean> => {
    try {
      const res = await fetch(
        `/api/assists/${encodeURIComponent(assistId)}/${decision}/${encodeURIComponent(requestId)}`,
        { method: 'POST' },
      );
      if (res.ok) {
        addToast('success', decision === 'approve' ? 'Approved' : 'Rejected', undefined);
        await loadList();
        return true;
      }
      addToast('error', `Could not ${decision}`, await readError(res));
    } catch (e) {
      addToast('error', `Could not ${decision}`, e instanceof Error ? e.message : 'Network error');
    }
    return false;
  }, [addToast, loadList]);

  /** Request a revert to a historical version (creates an approval request). */
  const revert = useCallback(async (id: string, version: number): Promise<boolean> => {
    try {
      const res = await fetch(`/api/assists/${encodeURIComponent(id)}/revert/${version}`, { method: 'POST' });
      if (res.ok) {
        addToast('success', `Revert to v${version} requested`, 'An admin must approve it before it takes effect.');
        await loadList();
        return true;
      }
      addToast('error', 'Could not request revert', await readError(res));
    } catch (e) {
      addToast('error', 'Could not request revert', e instanceof Error ? e.message : 'Network error');
    }
    return false;
  }, [addToast, loadList]);

  return {
    assists,
    approvals,
    loading,
    loadList,
    loadContent,
    loadHistory,
    propose,
    resolve,
    revert,
  };
}
