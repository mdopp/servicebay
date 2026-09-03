'use client';

import { useCallback, useMemo, useState } from 'react';
import { bulkRevokeApiTokens } from '@servicebay/api-client';
import {
  isSelectable,
  tokensMatchingFilter,
  type RevokeResult,
  type SelectionFilterId,
  type TokenView,
} from './apiTokenSelection';

export interface BulkRevokeReport {
  requested: number;
  revoked: number;
  results: RevokeResult[];
  /**
   * id → name for what the operator selected, captured before the run. The
   * server can only name a token it actually found, so a row that failed
   * *because it was already gone* comes back nameless — and an 8-hex id is not
   * what the operator picked from the list. This keeps the failure report in
   * the same vocabulary as the selection.
   */
  names: Record<string, string>;
}

/**
 * POST the bulk revoke and normalise the reply. Throws when the request itself
 * was rejected (400/401/…): there is no per-token report in that case, so the
 * caller must say "nothing was revoked" rather than imply anything about the
 * individual tokens.
 */
async function postBulkRevoke(selection: TokenView[]): Promise<BulkRevokeReport> {
  const ids = selection.map(t => t.id);
  const data = await bulkRevokeApiTokens(ids);
  return {
    requested: data.requested,
    revoked: data.revoked,
    results: data.results as RevokeResult[],
    names: Object.fromEntries(selection.map(t => [t.id, t.name])),
  };
}

/**
 * Selection state + the bulk-revoke run for the API-token list (#2608).
 *
 * Held here rather than in `ApiTokensSection` because the *rules* are the
 * interesting part and they are easier to keep honest away from the markup:
 * what may be selected, and the fact that a partial failure never closes the
 * dialog.
 *
 * A revoked (or swept) token's id may linger in `selected`; nothing reads the
 * raw set, so a stale id simply drops out of `selectedTokens` and can never
 * ride along into the next run.
 */
export function useBulkTokenRevoke(
  tokens: TokenView[] | null,
  currentTokenId: string | null,
  reload: () => void,
) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BulkRevokeReport | null>(null);

  const selectable = useMemo(
    () => (tokens ?? []).filter(t => isSelectable(t, currentTokenId)),
    [tokens, currentTokenId],
  );
  const selectedTokens = useMemo(() => selectable.filter(t => selected.has(t.id)), [selectable, selected]);

  // Plain closures, not useCallback: nothing downstream is memoised, so the
  // hook deps would cost more than the identity stability buys.
  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = selectable.length > 0 && selectedTokens.length === selectable.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map(t => t.id)));
  const applyFilter = (id: SelectionFilterId) => setSelected(new Set(tokensMatchingFilter(tokens ?? [], id, currentTokenId)));
  const clear = () => setSelected(new Set());
  /** Open or close the confirm dialog, always discarding a previous run's report. */
  const setDialogOpen = (next: boolean) => { setOpen(next); setError(null); setReport(null); };

  const run = useCallback(async (selection: TokenView[]) => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const next = await postBulkRevoke(selection);
      reload();
      // Close ONLY on a clean sweep. A partial run keeps the dialog open with
      // the denominator and the per-token reasons, and narrows the selection to
      // exactly what failed so a retry is one click — never the #2461 shape
      // where the dialog closed and a still-live token looked revoked.
      if (next.revoked === next.requested) {
        setSelected(new Set());
        setOpen(false);
        return;
      }
      setReport(next);
      setSelected(new Set(next.results.filter(r => !r.ok).map(r => r.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [reload]);

  return { selected, selectable, selectedTokens, allSelected, toggle, toggleAll, applyFilter, clear, open, setDialogOpen, running, error, report, run };
}
