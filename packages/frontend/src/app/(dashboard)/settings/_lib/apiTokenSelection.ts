/**
 * Selection + confirmation rules for the API-token list (#2608).
 *
 * Kept out of `ApiTokensSection.tsx` deliberately: these are the rules that
 * decide *what gets revoked* and *how hard it is to do by accident*, so they
 * are asserted directly rather than inferred from a rendered list.
 */

// The scope vocabulary is defined ONCE, in the backend (#2609). This file used
// to restate it as a shortened literal union missing `propose`, so the token UI
// could never offer a scope the server had accepted for months — and because
// `SCOPE_BADGE` in ApiTokensSection is keyed on the *local* type, widening the
// backend type would not even have turned the build red. Import, never restate.
import type { ApiScope } from '@/lib/auth/apiScope';

export interface TokenView {
  id: string;
  name: string;
  scopes: ApiScope[];
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  createdBy: string;
}

/** Counted states from the server's hygiene summary (#2606). */
export interface TokenSummary {
  total: number;
  expiredInGrace: number;
  neverExpires: number;
  neverUsed: number;
  dormant: number;
  privileged: number;
  graceDays: number;
}

/**
 * `destroy` and the two scopes split out of it. A token holding any of these
 * can delete services, exec a shell, or reboot the box — the difference that
 * decides how much friction a bulk revoke gets below.
 */
const PRIVILEGED_SCOPES: ApiScope[] = ['destroy', 'exec', 'reboot'];

export const isPrivileged = (t: TokenView): boolean => t.scopes.some(s => PRIVILEGED_SCOPES.includes(s));
export const isNeverUsed = (t: TokenView): boolean => !t.lastUsedAt;
export const hasNoExpiry = (t: TokenView): boolean => !t.expiresAt;
export const isExpired = (t: TokenView, now: number = Date.now()): boolean =>
  Boolean(t.expiresAt) && Date.parse(t.expiresAt as string) < now;

/** Older than N days by mint date — the "these have been sitting here since
 *  June" filter. Uses `createdAt`, which every token has, rather than
 *  `lastUsedAt`, which the never-used ones lack. */
export const isOlderThanDays = (t: TokenView, days: number, now: number = Date.now()): boolean =>
  Date.parse(t.createdAt) < now - days * 86_400_000;

/** The bulk filters offered as one-click selections. `id` doubles as the test
 *  handle and the button label suffix. */
export const SELECTION_FILTERS = [
  { id: 'never-used', label: 'Never used', match: (t: TokenView) => isNeverUsed(t) },
  { id: 'no-expiry', label: 'No expiry', match: (t: TokenView) => hasNoExpiry(t) },
  { id: 'expired', label: 'Expired', match: (t: TokenView, now: number) => isExpired(t, now) },
  { id: 'older-90d', label: 'Older than 90 days', match: (t: TokenView, now: number) => isOlderThanDays(t, 90, now) },
] as const;

export type SelectionFilterId = (typeof SELECTION_FILTERS)[number]['id'];

/**
 * A token the operator is allowed to bulk-select. The session's own bridged
 * token is excluded: including it would end the cleanup by logging the
 * operator out mid-list, with the remaining tokens unhandled (#2608). It stays
 * *visible* and individually revocable — this only keeps it out of "select
 * all" and the filters, where it would ride along unnoticed.
 */
export const isSelectable = (t: TokenView, currentTokenId: string | null): boolean => t.id !== currentTokenId;

/** Apply a named filter, honouring the own-token exclusion. */
export function tokensMatchingFilter(
  tokens: TokenView[],
  filterId: SelectionFilterId,
  currentTokenId: string | null,
  now: number = Date.now(),
): string[] {
  const filter = SELECTION_FILTERS.find(f => f.id === filterId);
  if (!filter) return [];
  return tokens.filter(t => isSelectable(t, currentTokenId) && filter.match(t, now)).map(t => t.id);
}

/**
 * The phrase the operator must type to confirm a bulk revoke.
 *
 * #2164 requires a typed confirmation on token revoke and #2608 removes the
 * *repetition*, not the safety — so there is still exactly one typed phrase,
 * and it is derived from the selection rather than fixed. A selection carrying
 * `destroy`/`exec`/`reboot` gets a longer phrase that spells out how many of
 * those there are: you cannot type it without having read the number, which is
 * the whole friction budget spent where the blast radius actually is.
 */
export function bulkConfirmPhrase(selected: TokenView[]): string {
  const privileged = selected.filter(isPrivileged).length;
  return privileged > 0
    ? `revoke ${selected.length} including ${privileged} destroy`
    : `revoke ${selected.length}`;
}

/** One-token outcome as reported by POST /api/system/api-tokens/revoke. */
export interface RevokeResult {
  id: string;
  name?: string;
  ok: boolean;
  error?: string;
}

/**
 * Turn a bulk-revoke response into the sentence the operator reads. Always
 * states the denominator — "3 of 12 revoked", never a bare "revoked" — because
 * a partial run that reads as a clean success is the exact failure #2461 fixed
 * for the single-token case.
 */
export function summarizeRevokeRun(requested: number, revoked: number): string {
  if (requested === 0) return 'Nothing selected.';
  if (revoked === requested) return `${revoked} of ${requested} revoked.`;
  return `${revoked} of ${requested} revoked — the rest are still active:`;
}
