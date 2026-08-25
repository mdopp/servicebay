'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import ConfirmModal from '@/components/ConfirmModal';
import { copyToClipboard } from '../clipboard';
import {
  SELECTION_FILTERS,
  bulkConfirmPhrase,
  isExpired,
  isPrivileged,
  summarizeRevokeRun,
  type ApiScope,
  type SelectionFilterId,
  type TokenSummary,
  type TokenView,
} from '../apiTokenSelection';
import { useBulkTokenRevoke, type BulkRevokeReport as BulkRevokeReportData } from '../useBulkTokenRevoke';

const ALL_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate', 'reboot', 'destroy', 'exec'];

type BootstrapStatus =
  | { active: false; present?: boolean }
  | { active: true; present?: boolean; expiresAt: string | null; minutesRemaining: number | null };

// Scope tiers mapped onto semantic status/accent tokens (#2100): destroy =
// status-fail (most dangerous), exec = accent, mutate/reboot = status-warn,
// lifecycle = status-info, read = neutral surface.
const SCOPE_BADGE: Record<ApiScope, string> = {
  destroy: 'bg-status-fail/10 text-status-fail border border-status-fail/20',
  exec: 'bg-accent/10 text-accent border border-accent/20',
  mutate: 'bg-status-warn/10 text-status-warn border border-status-warn/20',
  reboot: 'bg-status-warn/10 text-status-warn border border-status-warn/20',
  lifecycle: 'bg-status-info/10 text-status-info border border-status-info/20',
  read: 'bg-surface-2 text-text-muted border border-border',
};

function BootstrapBanner({ status, revoking, reactivating, onRevoke, onReactivate }: { status: BootstrapStatus; revoking: boolean; reactivating: boolean; onRevoke: () => void; onReactivate: () => void }) {
  // Show whenever the bootstrap entry still exists — including after its
  // window lapsed — so an expired token can be re-activated (#1419).
  if (!status.active && !status.present) return null;
  // `!`-prefixed: Button's default ghost/md classes (bg-transparent, text-text-muted,
  // hover:bg-surface-2, h-10, px-space-4) sort after these in the compiled stylesheet
  // and would otherwise silently win, dropping the warning tint and enlarging the
  // button (confirmed via the compiled CSS rule order — #2484).
  const btnClass = '!h-auto !text-xs font-medium !px-3 !py-1.5 rounded-card border border-status-warn/40 !text-status-warn !bg-status-warn/10 hover:!bg-status-warn/20 disabled:opacity-50';
  return (
    <div className="mt-4 rounded-card border border-status-warn/30 bg-status-warn/10 px-4 py-3 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-status-warn">{status.active ? 'Bootstrap token active' : 'Bootstrap token expired'}</p>
        <p className="text-xs text-text-muted mt-0.5">
          {status.active
            ? (status.minutesRemaining !== null
                ? `LAN-only, read scope, ${status.minutesRemaining} min remaining.`
                : 'LAN-only, read scope. Expiry will be set on next server boot.')
            : 'LAN-only, read scope. Re-activate to reconnect an MCP client for ~30 min — same token, no new credential.'}
          {' '}Auto-revokes when you mint your first regular token below.
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <Button
          type="button"
          disabled={reactivating}
          onClick={onReactivate}
          variant="ghost"
          className={btnClass}
          title="Re-issue the existing LAN-only bootstrap token for another ~30 minutes so an MCP client can reconnect — same token value."
        >
          {reactivating ? 'Re-activating…' : 'Re-activate (30 min)'}
        </Button>
        <Button type="button" disabled={revoking} onClick={onRevoke} variant="ghost" className={btnClass}>
          {revoking ? 'Revoking…' : 'Revoke now'}
        </Button>
      </div>
    </div>
  );
}

function RevealedSecretBox({ secret, copied, onCopy, onDismiss }: { secret: string; copied: boolean; onCopy: () => void; onDismiss: () => void }) {
  return (
    <div className="p-3 bg-status-warn/10 rounded-card border border-status-warn/30 space-y-2">
      <p className="text-xs font-semibold text-status-warn">⚠️ Save this token now — it will not be shown again.</p>
      <div className="flex items-stretch gap-2">
        <Input
          type="text"
          readOnly
          value={secret}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 font-mono text-xs px-2 py-1.5 rounded-card border border-border bg-surface-2 text-text"
        />
        <Button type="button" size="sm" onClick={onCopy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

interface TokenRowProps {
  token: TokenView;
  selected: boolean;
  isCurrent: boolean;
  onToggleSelect: (id: string) => void;
  onRevoke: (id: string, name: string) => void;
}

/** Scope badges + the expiry/last-used line. Split out of TokenRow purely to
 *  keep each function inside the 50-line lint budget. */
function TokenMeta({ token }: { token: TokenView }) {
  const expired = isExpired(token);
  return (
    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
      {token.scopes.map(s => (
        <span key={s} className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-chip ${SCOPE_BADGE[s]}`}>{s}</span>
      ))}
      {/* A token minted with "Never Expires" carries no expiresAt (#2299) —
          surface it so the operator can tell a long-lived machine token from
          an expiring one at a glance. An already-lapsed one is called out
          too: it is kept for a short grace so it can be recognised as the
          reason a client started failing, then removed (#2606). */}
      {expired ? (
        <span className="text-[10px] font-medium text-status-warn">
          expired {new Date(token.expiresAt as string).toLocaleString()} — removed after the grace period
        </span>
      ) : (
        <span className="text-[10px] text-text-subtle">
          {token.expiresAt ? `expires ${new Date(token.expiresAt).toLocaleString()}` : 'Expires: Never'}
        </span>
      )}
      <span className="text-[10px] text-text-subtle">
        {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'never used'}
      </span>
    </div>
  );
}

function TokenRow({ token, selected, isCurrent, onToggleSelect, onRevoke }: TokenRowProps) {
  return (
    <li className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-card border border-border bg-surface-2">
      {/* The session's own bridged token stays listed and individually
          revocable, but is locked out of bulk selection — a cleanup must not
          end by logging the operator out mid-list (#2608). */}
      <Input
        type="checkbox"
        checked={selected}
        disabled={isCurrent}
        onChange={() => onToggleSelect(token.id)}
        className="shrink-0 rounded accent-accent"
        aria-label={isCurrent ? `${token.name} (this session — cannot be bulk-revoked)` : `Select ${token.name}`}
        title={isCurrent ? 'This is the token your current session is using.' : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-text truncate">{token.name}</span>
          <span className="font-mono text-xs text-text-subtle">sb_{token.id}_{token.prefix}…</span>
          {isCurrent && (
            <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-chip bg-accent/10 text-accent border border-accent/20">This session</span>
          )}
        </div>
        <TokenMeta token={token} />
      </div>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => onRevoke(token.id, token.name)}
        aria-label={`Revoke ${token.name}`}
        title="Revoke"
        className="shrink-0 h-8 w-8 px-0"
      >
        <Trash2 size={14} />
      </Button>
    </li>
  );
}

/**
 * The counted states from #2606. Never-expiring and never-used tokens are
 * shown, not swept: an unattended consumer that runs once a quarter looks
 * exactly like a dead credential from here, so the call is the operator's.
 */
function TokenHygiene({ summary }: { summary: TokenSummary }) {
  const parts = [
    `${summary.total} token${summary.total === 1 ? '' : 's'}`,
    summary.neverExpires > 0 ? `${summary.neverExpires} never expire` : null,
    summary.neverUsed > 0 ? `${summary.neverUsed} never used` : null,
    summary.dormant > 0 ? `${summary.dormant} never used and never expiring` : null,
    summary.privileged > 0 ? `${summary.privileged} carry destroy` : null,
    summary.expiredInGrace > 0 ? `${summary.expiredInGrace} expired (auto-removed after ${summary.graceDays} days)` : null,
  ].filter(Boolean);
  return (
    <p role="status" className="text-[11px] text-text-muted">
      {parts.join(' · ')}
    </p>
  );
}

interface SelectionToolbarProps {
  selectedCount: number;
  selectableCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onFilter: (id: SelectionFilterId) => void;
  onClear: () => void;
  onRevokeSelected: () => void;
}

/** Multi-select controls (#2608). The filters are the actual value here —
 *  "all never used", "all without an expiry" — since hand-ticking 34 rows is
 *  the same chore with fewer clicks. */
function SelectionToolbar(props: SelectionToolbarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap px-2 py-1.5 rounded-card border border-border bg-surface">
      <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
        <Input
          type="checkbox"
          checked={props.allSelected}
          onChange={props.onToggleAll}
          className="rounded accent-accent"
          aria-label="Select all tokens"
        />
        <span>All ({props.selectableCount})</span>
      </label>
      <span className="text-[11px] text-text-subtle">Select:</span>
      {SELECTION_FILTERS.map(f => (
        <Button key={f.id} type="button" variant="ghost" size="sm" onClick={() => props.onFilter(f.id)}>
          {f.label}
        </Button>
      ))}
      <div className="ml-auto flex items-center gap-2">
        {props.selectedCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={props.onClear}>
            Clear
          </Button>
        )}
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={props.selectedCount === 0}
          onClick={props.onRevokeSelected}
        >
          <Trash2 size={12} />
          Revoke selected ({props.selectedCount})
        </Button>
      </div>
    </div>
  );
}

/** The per-token outcome list. Rendered inside ConfirmModal's message, which
 *  is a `<p>` — so every element here is an inline-level `<span>` made block
 *  by class, never a `<div>`/`<ul>`. */
function BulkRevokeReport({ requested, revoked, results, names }: BulkRevokeReportData) {
  const failed = results.filter(r => !r.ok);
  return (
    <span role="alert" className={`mt-2 block ${failed.length > 0 ? 'text-status-fail' : 'text-text-muted'}`}>
      <span className="block font-medium">{summarizeRevokeRun(requested, revoked)}</span>
      {failed.map(r => (
        <span key={r.id} className="mt-1 block text-xs">
          <span className="font-mono">{r.name ?? names[r.id] ?? r.id}</span> — {r.error ?? 'revoke failed'}
        </span>
      ))}
    </span>
  );
}

/**
 * Bulk revoke (#2608): ONE typed confirmation over a list that names every
 * token, its scopes and its last use — a count alone ("revoke 12 tokens?") is
 * not enough to decide when 20 of 34 carry destroy. The phrase the operator
 * types scales with the selection's blast radius (see `bulkConfirmPhrase`).
 */
function BulkRevokeModal({ bulk }: { bulk: ReturnType<typeof useBulkTokenRevoke> }) {
  const { selectedTokens, running, report, error } = bulk;
  return (
    <ConfirmModal
      isOpen={bulk.open}
      title={`Revoke ${selectedTokens.length} API token${selectedTokens.length === 1 ? '' : 's'}`}
      isDestructive
      requireTypedConfirm
      resourceName={bulkConfirmPhrase(selectedTokens)}
      isLoading={running}
      confirmText={running ? 'Revoking…' : `Revoke ${selectedTokens.length}`}
      message={
        <>
          Every client using one of these tokens — an MCP assistant, the ServiceBay TUI, or a script — is locked out immediately. This cannot be undone.
          <span className="mt-2 block max-h-60 overflow-y-auto rounded-card border border-border bg-surface-2 p-2 text-xs">
            {selectedTokens.map(t => (
              <span key={t.id} className="block py-0.5">
                <span className="font-medium text-text">{t.name}</span>{' '}
                <span className={isPrivileged(t) ? 'font-mono text-status-fail' : 'font-mono text-text-subtle'}>
                  [{t.scopes.join(',')}]
                </span>{' '}
                <span className="text-text-subtle">
                  {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used'}
                </span>
              </span>
            ))}
          </span>
          {report && <BulkRevokeReport {...report} />}
          {error && (
            <span role="alert" className="mt-2 block text-status-fail">
              {error} — nothing was revoked.
            </span>
          )}
        </>
      }
      onConfirm={() => { if (selectedTokens.length > 0) void bulk.run(selectedTokens); }}
      onCancel={() => { if (!running) bulk.setDialogOpen(false); }}
    />
  );
}

interface CreateTokenFormProps {
  name: string;
  scopes: ApiScope[];
  neverExpires: boolean;
  creating: boolean;
  error: string | null;
  onName: (v: string) => void;
  onToggleScope: (s: ApiScope) => void;
  onToggleNeverExpires: () => void;
  onCreate: () => void;
  onCancel: () => void;
}

/** A "Never Expires" token is fail-closed to the read scope only (#2299) — the
 *  server refuses any other scope with a 403, so the checkbox is only offered
 *  when the selected scope set is exactly read-only. */
function isReadOnlyScopeSet(scopes: ApiScope[]): boolean {
  return scopes.length > 0 && scopes.every(s => s === 'read');
}

/** The "Never Expires" checkbox (#2299): enabled only for a read-only scope
 *  set, mirroring the server's fail-closed 403 guard. */
function NeverExpiresField({ readOnly, checked, onToggle }: { readOnly: boolean; checked: boolean; onToggle: () => void }) {
  return (
    <div>
      <label
        className={`flex items-center gap-1.5 text-xs ${readOnly ? 'cursor-pointer text-text-muted' : 'cursor-not-allowed text-text-subtle opacity-60'}`}
        title={readOnly ? 'Mint a non-expiring token — safe only for a read-only, unattended consumer.' : 'Never-expiring tokens are limited to the read scope. Select only "read" to enable this.'}
      >
        <Input
          type="checkbox"
          checked={readOnly && checked}
          disabled={!readOnly}
          onChange={onToggle}
          className="rounded accent-accent"
          aria-label="Never Expires"
        />
        <span>Never Expires</span>
      </label>
      <p className="text-[10px] text-text-subtle mt-1">For an unattended machine consumer. Only available when the scope set is read-only.</p>
    </div>
  );
}

function CreateTokenForm(props: CreateTokenFormProps) {
  const readOnly = isReadOnlyScopeSet(props.scopes);
  return (
    <div className="space-y-2 p-3 rounded-card border border-border bg-surface-2">
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-text-subtle mb-1">Name</label>
        <Input
          type="text"
          value={props.name}
          onChange={e => props.onName(e.target.value)}
          placeholder="e.g. Claude Code on workstation"
          className="w-full px-2 py-1.5 text-sm rounded-card border border-border bg-surface text-text focus:ring-2 focus:ring-accent outline-none"
        />
      </div>
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-text-subtle mb-1">Scopes</label>
        <div className="flex flex-wrap gap-2">
          {ALL_SCOPES.map(scope => (
            <label key={scope} className="flex items-center gap-1.5 text-xs cursor-pointer text-text-muted">
              <Input type="checkbox" checked={props.scopes.includes(scope)} onChange={() => props.onToggleScope(scope)} className="rounded accent-accent" />
              <span className="font-mono">{scope}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-text-subtle mt-1">read = list/get only. lifecycle = start/stop/restart + force-update (re-pull an image, snapshot + email each time). mutate = create/update/config-edit. reboot = reboot the node (transient, recoverable). destroy = delete/restore/purge/factory-reset. exec = exec_command/container_exec (a shell on the box). Tokens with destroy also implicitly grant reboot — but never exec: a token has shell only if you tick exec here.</p>
      </div>
      <NeverExpiresField readOnly={readOnly} checked={props.neverExpires} onToggle={props.onToggleNeverExpires} />
      {props.error && <p className="text-xs text-status-fail">{props.error}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={props.onCreate}
          disabled={props.creating || !props.name.trim() || props.scopes.length === 0}
          className="flex-1"
        >
          {props.creating ? 'Creating…' : 'Create'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Named, revocable API tokens — the single credential surface for both the
 * MCP server and (opt-in) REST API routes (#1264). Split out of the MCP
 * settings section once the same token started authenticating REST too, so
 * token management lives in one place regardless of which surface uses it.
 */
export default function ApiTokensSection() {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [revokingBootstrap, setRevokingBootstrap] = useState(false);
  const [reactivatingBootstrap, setReactivatingBootstrap] = useState(false);
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<ApiScope[]>(['read']);
  // Non-expiring machine token (#2299) — only honored when the scope set is
  // read-only (the server 403s otherwise).
  const [newNeverExpires, setNewNeverExpires] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  // Tokens gate MCP/agent access, so revoke is a typed-confirmation destructive
  // action (ConfirmModal), consistent with stack-wipe / service-delete /
  // factory-reset — never a bare browser confirm() (#2164).
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // Bulk revoke (#2608): one typed confirmation over a visible selection,
  // replacing N repetitions of the same gesture — which is habituation, not
  // care. `summary` and `currentTokenId` come from the same GET.
  const [summary, setSummary] = useState<TokenSummary | null>(null);
  const [currentTokenId, setCurrentTokenId] = useState<string | null>(null);

  // The hash is set by the install script; this UI just reflects status +
  // offers a manual revoke. Auto-revoked when the operator mints their first
  // regular token (#322).
  const loadBootstrap = useCallback(() => {
    fetch('/api/system/mcp-bootstrap')
      .then(r => r.ok ? r.json() : { active: false })
      .then((data: BootstrapStatus) => setBootstrap(data))
      .catch(() => setBootstrap({ active: false }));
  }, []);

  const loadTokens = useCallback(() => {
    fetch('/api/system/api-tokens')
      .then(r => r.ok ? r.json() : { tokens: [] })
      .then(data => {
        const list: TokenView[] = data.tokens ?? [];
        setTokens(list);
        setSummary(data.summary ?? null);
        setCurrentTokenId(data.currentTokenId ?? null);
      })
      .catch(() => setTokens([]));
  }, []);

  const bulk = useBulkTokenRevoke(tokens, currentTokenId, loadTokens);

  useEffect(() => {
    loadBootstrap();
    loadTokens();
  }, [loadBootstrap, loadTokens]);

  const revokeBootstrap = async () => {
    setRevokingBootstrap(true);
    try {
      await fetch('/api/system/mcp-bootstrap', { method: 'DELETE' });
      loadBootstrap();
    } finally {
      setRevokingBootstrap(false);
    }
  };

  // Re-issue the existing bootstrap token for another ~30 min (#1419) — same
  // token value, so an MCP client reconnects without a fresh credential.
  const reactivateBootstrap = async () => {
    setReactivatingBootstrap(true);
    try {
      await fetch('/api/system/mcp-bootstrap', { method: 'POST' });
      loadBootstrap();
    } finally {
      setReactivatingBootstrap(false);
    }
  };

  const createNewToken = async () => {
    if (!newName.trim() || newScopes.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      // Only a read-only scope set may carry neverExpires (the server enforces
      // this too, fail-closed) — never send it alongside a broader scope.
      const readOnly = newScopes.length > 0 && newScopes.every(s => s === 'read');
      const res = await fetch('/api/system/api-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), scopes: newScopes, neverExpires: readOnly && newNeverExpires }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRevealedSecret(data.secret);
      setNewName('');
      setNewScopes(['read']);
      setNewNeverExpires(false);
      setShowCreate(false);
      loadTokens();
      // Server-side createToken auto-revokes the bootstrap token —
      // refresh the banner so the operator sees it disappear.
      loadBootstrap();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revokeOneToken = (id: string, name: string) => {
    setRevokeError(null);
    setRevokeTarget({ id, name });
  };

  const confirmRevoke = async () => {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/system/api-tokens?id=${revokeTarget.id}`, { method: 'DELETE' });
      // Close the dialog only when the token is actually gone. Closing
      // unconditionally made a failed revoke look like a success, so the
      // operator believed a live token was locked out (#2461).
      if (!res.ok) {
        const detail = await res.json().then(d => d?.error).catch(() => null);
        setRevokeError(detail || `Revoke failed — HTTP ${res.status}`);
        return;
      }
      loadTokens();
      setRevokeTarget(null);
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevoking(false);
    }
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    if (await copyToClipboard(revealedSecret)) {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 1500);
    }
  };

  const toggleScope = (scope: ApiScope) => {
    setNewScopes(prev => {
      const next = prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope];
      // Leaving a read-only scope set disables "Never Expires" — clear it so a
      // stale checked state can't ride along to a broader-scope mint (#2299).
      if (!(next.length > 0 && next.every(s => s === 'read'))) setNewNeverExpires(false);
      return next;
    });
  };

  const toggleNeverExpires = () => setNewNeverExpires(prev => !prev);

  return (
    <>
      {bootstrap && <BootstrapBanner status={bootstrap} revoking={revokingBootstrap} reactivating={reactivatingBootstrap} onRevoke={revokeBootstrap} onReactivate={reactivateBootstrap} />}

      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Pass as <span className="font-mono">Authorization: Bearer sb_…</span> on MCP requests and on opt-in REST API routes. Each token is revocable here without disturbing other clients, and appears as <span className="font-mono">caller</span> in the MCP audit log.
        </p>

        {revealedSecret && (
          <RevealedSecretBox secret={revealedSecret} copied={secretCopied} onCopy={copySecret} onDismiss={() => setRevealedSecret(null)} />
        )}

        {tokens && tokens.length > 0 && (
          <>
            {summary && <TokenHygiene summary={summary} />}
            <SelectionToolbar
              selectedCount={bulk.selectedTokens.length}
              selectableCount={bulk.selectable.length}
              allSelected={bulk.allSelected}
              onToggleAll={bulk.toggleAll}
              onFilter={bulk.applyFilter}
              onClear={bulk.clear}
              onRevokeSelected={() => bulk.setDialogOpen(true)}
            />
            <ul className="space-y-1.5">
              {tokens.map(t => (
                <TokenRow
                  key={t.id}
                  token={t}
                  selected={bulk.selected.has(t.id)}
                  isCurrent={t.id === currentTokenId}
                  onToggleSelect={bulk.toggle}
                  onRevoke={revokeOneToken}
                />
              ))}
            </ul>
          </>
        )}
        {tokens && tokens.length === 0 && !showCreate && (
          <p className="text-xs text-text-subtle italic">No tokens yet. Create one per client — an MCP assistant (Claude Code, Claude Desktop, …), the ServiceBay TUI, or a script.</p>
        )}

        {showCreate ? (
          <CreateTokenForm
            name={newName}
            scopes={newScopes}
            neverExpires={newNeverExpires}
            creating={creating}
            error={createError}
            onName={setNewName}
            onToggleScope={toggleScope}
            onToggleNeverExpires={toggleNeverExpires}
            onCreate={createNewToken}
            onCancel={() => { setShowCreate(false); setCreateError(null); }}
          />
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={12} />
            New token
          </Button>
        )}
      </div>

      <ConfirmModal
        isOpen={revokeTarget !== null}
        title="Revoke API token"
        isDestructive
        requireTypedConfirm
        resourceName={revokeTarget?.name ?? ''}
        isLoading={revoking}
        confirmText={revoking ? 'Revoking…' : 'Revoke token'}
        message={
          <>
            Any client using this token — an MCP assistant, the ServiceBay TUI, or a script — is locked out immediately. This cannot be undone.
            {revokeError && (
              <span role="alert" className="mt-2 block text-status-fail">
                {revokeError} — the token is still active.
              </span>
            )}
          </>
        }
        onConfirm={confirmRevoke}
        onCancel={() => {
          if (revoking) return;
          setRevokeError(null);
          setRevokeTarget(null);
        }}
      />

      <BulkRevokeModal bulk={bulk} />
    </>
  );
}
