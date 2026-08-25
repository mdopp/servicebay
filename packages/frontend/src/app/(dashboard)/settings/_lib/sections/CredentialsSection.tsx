'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import {
  isCredentialSecured,
  isHttpUrl,
  resolveCredentialUrl,
  summarizeCredentialSecurity,
  type CredentialView,
  type CredentialSecuritySummary,
  type CredentialUrlHost,
} from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';
import { notifyCredentialsChanged } from '@/components/CredentialHandoverGate';
import { useCredentialHandover } from '@/hooks/useCredentialHandover';
import { Badge, Button, DataTable, type Column } from '@/components/ui';

interface Manifest {
  savedAt: string;
  credentials: CredentialView[];
}

/** URL cell (#1626): render an admin-reachable http(s) URL as a clickable
 *  link; render non-URL hints (`env:`, `\\…`, `ssh://`, bearer tokens) as
 *  plain text. The loopback→public-subdomain rewrite happens in
 *  `resolveCredentialUrl`.
 *
 *  No `break-all` here (#2520) — it collapsed the cell's min-content width to a
 *  single character, so the auto table-layout crushed this column to ~8 chars
 *  and rendered `https://nginx.dopp.cloud` as "http/s://ngi/nx.dop/p.cloud".
 *  <DataTable>'s cells carry `break-words`, which contains a long URL without
 *  ever breaking it mid-token. */
function CredentialUrlCell({ cred, hosts, publicDomain }: {
  cred: CredentialView;
  hosts: CredentialUrlHost[];
  publicDomain: string | null;
}) {
  const resolved = resolveCredentialUrl(cred, { hosts, publicDomain: publicDomain ?? undefined });
  if (!isHttpUrl(resolved)) return <span>{resolved}</span>;
  return (
    <a
      href={resolved}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline"
    >
      {resolved}
    </a>
  );
}

/** Vaultwarden deep link — an <a> (navigation), styled like a secondary Button. */
function VaultLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={'inline-flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-surface-muted ' +
        'text-text text-sm font-medium rounded-card border border-border transition-colors'}
    >
      <ExternalLink size={14} />
      {children}
    </a>
  );
}

/** The line that replaced the password column: where these secrets live. */
function HandoverStatus({ summary, savedAt }: {
  summary: CredentialSecuritySummary;
  savedAt: string;
}) {
  return (
    <div className="space-y-1">
      {summary.unsecured > 0 ? (
        <p className="text-sm text-status-warn" data-testid="credentials-sync-status">
          {summary.unsecured} of {summary.total} not handed over yet — ServiceBay is still the only place
          {summary.unsecured === 1 ? ' this password lives' : ' these passwords live'}.
        </p>
      ) : (
        <p className="text-sm text-status-ok" data-testid="credentials-sync-status">
          All {summary.total} entries have been handed over. ServiceBay no longer stores these passwords.
        </p>
      )}
      <p className="text-xs text-text-muted">
        Last updated {new Date(savedAt).toLocaleString()}. Passwords are never shown here — open the entry
        in your password manager.
      </p>
    </div>
  );
}

const TIP_DOWNLOAD =
  "Download the passwords ServiceBay still holds. Its copy is deleted the moment the file reaches you.";
const TIP_WIPE = 'Remove the whole list from ServiceBay, handed-over entries included.';

function CredentialActions({ summary, vaultBase, busy, downloading, onDownload, onWipe }: {
  summary: CredentialSecuritySummary;
  vaultBase: string | null;
  busy: 'wipe' | null;
  downloading: boolean;
  onDownload: () => void;
  onWipe: () => void;
}) {
  const pending = summary.unsecured > 0;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pending && (
        <Button onClick={onDownload} disabled={downloading} variant="primary" size="md" title={TIP_DOWNLOAD}>
          {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Download the password list
        </Button>
      )}
      {vaultBase && pending && (
        <VaultLink href={`${vaultBase}/#/tools/import`}>Open Vaultwarden import</VaultLink>
      )}
      {vaultBase && !pending && (
        <VaultLink href={`${vaultBase}/#/vault`}>Open in Vaultwarden</VaultLink>
      )}
      <Button onClick={onWipe} disabled={busy === 'wipe'} variant="danger" size="md" title={TIP_WIPE}>
        {busy === 'wipe' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        Forget entries
      </Button>
    </div>
  );
}

function ServiceCell(c: CredentialView) {
  return (
    <div>
      {c.service}
      {c.importance === 'system' && (
        <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">system</span>
      )}
    </div>
  );
}

function StoredInCell(c: CredentialView) {
  if (!isCredentialSecured(c)) return <Badge variant="warn">Not handed over</Badge>;
  return <Badge variant="ok">Handed over</Badge>;
}

/** Explicit per-column widths (#2520): without them the browser's auto
 *  table-layout hands the spare width to whichever column holds the longest
 *  prose — Notes — and starves Service/URL/Username. These are preferred
 *  widths, so a column still grows past its share rather than clipping; the
 *  table's min-width makes a narrow viewport scroll instead of crushing them. */
function credentialColumns(
  proxyHosts: CredentialUrlHost[],
  publicDomain: string | null,
): Column<CredentialView>[] {
  return [
    { key: 'service', header: 'Service', className: 'w-[16%]', align: 'left', cell: ServiceCell },
    {
      key: 'url',
      header: 'URL',
      cell: (c) => <CredentialUrlCell cred={c} hosts={proxyHosts} publicDomain={publicDomain} />,
      align: 'left',
      className: 'w-[28%] font-mono text-xs',
    },
    {
      key: 'username',
      header: 'Username',
      cell: (c) => c.username,
      align: 'left',
      className: 'w-[16%] font-mono text-xs',
    },
    // "Stored in" replaces the old Password column: where the secret lives,
    // never the secret itself.
    { key: 'status', header: 'Stored in', className: 'w-[18%]', align: 'left', cell: StoredInCell },
    {
      key: 'notes',
      header: 'Notes',
      cell: (c) => c.notes ?? '',
      align: 'left',
      className: 'w-[22%] text-xs text-text-muted',
    },
  ];
}

/**
 * Settings → Saved credentials (#2560).
 *
 * Not a password table and not a second password manager: it shows **where
 * each credential lives**, never the secret.
 *
 *   - "Handed over" — the file reached the operator and ServiceBay dropped
 *     its copy; only the pointer (service/URL/username) is left.
 *   - "Not handed over" — ServiceBay is still the only place this secret
 *     exists. That is the state to act on.
 *
 * The download here runs exactly the same proven-delivery hand-over as the
 * blocking gate at install end (`hooks/useCredentialHandover`) — there is
 * one way for a password to leave this box, and it deletes the local copy
 * only against evidence the file arrived. This entry point exists for the
 * operator who wants the list again after a headless install, or who
 * dismissed nothing and simply came here first.
 *
 * The automated Vaultwarden push that briefly lived here was removed in
 * #2560: it re-implemented Bitwarden's key ladder by hand and was never
 * validated against a real Vaultwarden. Writing into the operator's
 * *personal* vault was never possible at all — see
 * `assists/footgun-vaultwarden-personal-vault-write.md`.
 */
export default function CredentialsSection() {
  const { addToast } = useToast();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [proxyHosts, setProxyHosts] = useState<CredentialUrlHost[]>([]);
  const [publicDomain, setPublicDomain] = useState<string | null>(null);
  const [busy, setBusy] = useState<'load' | 'wipe' | null>('load');
  const { run: runHandover, busy: downloading } = useCredentialHandover();

  const load = () =>
    fetch('/api/system/credentials')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) {
          setManifest(data.manifest ?? null);
          setProxyHosts(Array.isArray(data.proxyHosts) ? data.proxyHosts : []);
          setPublicDomain(data.publicDomain ?? null);
        }
      });

  useEffect(() => {
    // Mount-only: the section re-reads on demand after a hand-over/wipe.
    load().finally(() => setBusy(null));
  }, []);

  const credentials = useMemo(() => manifest?.credentials ?? [], [manifest]);
  const summary = useMemo(() => summarizeCredentialSecurity(credentials), [credentials]);

  // Vaultwarden deep links (#1627): only when vaultwarden is installed (has
  // a proxy host). Derive the domain from the proxy host so we don't
  // hardcode `vault`/the public domain.
  const vaultHost = proxyHosts.find(h => h.service === 'vaultwarden');
  const vaultBase = vaultHost?.domain ? `https://${vaultHost.domain}` : null;

  const onDownload = async () => {
    const outcome = await runHandover();
    await load();
    // The gate elsewhere on the page reads the same state; keep it honest.
    notifyCredentialsChanged();
    if (outcome.status === 'delivered') {
      addToast(
        'success',
        'Passwords handed over',
        `${outcome.dropped} password(s) are now yours alone — ServiceBay deleted its copy. Put the file into Vaultwarden and share it with no one.`,
      );
    } else if (outcome.status === 'failed') {
      addToast('error', 'The download did not complete', `${outcome.message} Nothing was deleted.`);
    }
  };

  const onWipe = async () => {
    if (!window.confirm(
      'Forget these entries entirely?\n\n' +
      'This removes the whole list, including passwords you have not saved yet — make sure you have them first. The credentials themselves remain in the running services; this only clears ServiceBay\'s record.',
    )) return;
    setBusy('wipe');
    try {
      const res = await fetch('/api/system/credentials', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast('error', 'Could not wipe credentials', data.error || `HTTP ${res.status}`);
        return;
      }
      setManifest(null);
      notifyCredentialsChanged();
      addToast('success', 'Entries forgotten', 'Services keep running with the same passwords — they just aren\'t in ServiceBay\'s config anymore.');
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'load') {
    return (
      <p className="text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading credentials…
      </p>
    );
  }

  return (
    <>
      {summary.total > 0 && (
        <HandoverStatus summary={summary} savedAt={manifest!.savedAt} />
      )}

      {summary.total > 0 && (
        <CredentialActions
          summary={summary}
          vaultBase={vaultBase}
          busy={busy}
          downloading={downloading}
          onDownload={onDownload}
          onWipe={onWipe}
        />
      )}

      <div>
        {summary.total === 0 ? (
          <p className="text-sm text-text-muted italic">
            Nothing saved yet. The install wizard writes here at the end of every successful run.
          </p>
        ) : (
          <DataTable<CredentialView>
            columns={credentialColumns(proxyHosts, publicDomain)}
            // Above the primitive's 5x8rem default: these five columns are all
            // dense (a URL, an e-mail username, a status chip, a sentence of
            // notes), so a 40rem floor still stacks the notes 6 lines deep on a
            // phone. 56rem keeps every row ~2 lines and lets the wrapper scroll.
            minWidthClassName="min-w-[56rem]"
            rows={credentials}
            rowKey={(c, i) => String(i)}
            rowClassName={(c) => (c.importance === 'critical' ? '' : 'opacity-80')}
            empty="No credentials saved"
          />
        )}
      </div>
    </>
  );
}
