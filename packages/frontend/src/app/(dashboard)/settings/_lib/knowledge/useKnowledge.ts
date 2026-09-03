// Data layer for the Knowledge (assists) editor (#2228) — all calls against the
// `/api/assists/*` REST API shipped in #2221 plus the generic `/api/approvals`
// list (assist-edit requests are surfaced there). Kept out of the component so
// the view stays declarative.

'use client';

import { useCallback, useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import {
  fetchAssistsList,
  fetchAssistContent,
  fetchAssistHistory,
  proposeAssistEdit,
  decideAssistEdit,
  revertAssist,
  fetchApprovals,
  TypedFetchError,
} from '@servicebay/api-client';
import type { AssistApproval, AssistSummary, HistoryEntry } from './types';

function errorMessage(e: unknown): string {
  return e instanceof TypedFetchError || e instanceof Error ? e.message : 'Network error';
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
      const [listResult, apprResult] = await Promise.allSettled([
        fetchAssistsList(),
        fetchApprovals(),
      ]);
      if (listResult.status === 'fulfilled') {
        // `kind` is validated as a tolerant string (api-client), narrowed
        // here to the closed local union — same convention as the approvals
        // payload cast below.
        setAssists(listResult.value.assists as AssistSummary[]);
      } else {
        addToast('error', 'Could not load the knowledge catalog', errorMessage(listResult.reason));
      }
      if (apprResult.status === 'fulfilled') {
        // Approvals failing to load is non-fatal here (pre-existing
        // behaviour) — only the assist-edit ones are surfaced, and this tab
        // still works without the pending-approvals list.
        const all = apprResult.value.approvals as unknown as AssistApproval[];
        setApprovals(all.filter(a => a.payload?.kind === 'assist-edit'));
      }
    } catch (e) {
      addToast('error', 'Could not load the knowledge catalog', errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  /** Fetch the raw markdown (frontmatter + body) of one entry. */
  const loadContent = useCallback(async (id: string): Promise<string | null> => {
    try {
      const data = await fetchAssistContent(id);
      return data.content;
    } catch (e) {
      addToast('error', 'Could not load entry', errorMessage(e));
    }
    return null;
  }, [addToast]);

  /** Fetch the ordered edit history for an entry. */
  const loadHistory = useCallback(async (id: string): Promise<HistoryEntry[]> => {
    try {
      const data = await fetchAssistHistory(id);
      return data.history;
    } catch {
      /* non-fatal — history is auxiliary */
    }
    return [];
  }, []);

  /** Submit an edit proposal. Surfaces the backend 400/422 (frontmatter/secret) cleanly. */
  const propose = useCallback(async (id: string, content: string, message: string): Promise<boolean> => {
    try {
      await proposeAssistEdit(id, content, message);
      addToast('success', 'Proposal submitted', 'An admin must approve it before it takes effect.');
      await loadList();
      return true;
    } catch (e) {
      addToast('error', 'Proposal rejected', errorMessage(e));
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
      await decideAssistEdit(assistId, requestId, decision);
      addToast('success', decision === 'approve' ? 'Approved' : 'Rejected', undefined);
      await loadList();
      return true;
    } catch (e) {
      addToast('error', `Could not ${decision}`, errorMessage(e));
    }
    return false;
  }, [addToast, loadList]);

  /** Request a revert to a historical version (creates an approval request). */
  const revert = useCallback(async (id: string, version: number): Promise<boolean> => {
    try {
      await revertAssist(id, version);
      addToast('success', `Revert to v${version} requested`, 'An admin must approve it before it takes effect.');
      await loadList();
      return true;
    } catch (e) {
      addToast('error', 'Could not request revert', errorMessage(e));
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
