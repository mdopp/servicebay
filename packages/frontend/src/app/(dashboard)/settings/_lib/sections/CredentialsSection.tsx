'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import {
  buildBitwardenCsv,
  isCredentialSecured,
  isHttpUrl,
  resolveCredentialUrl,
  summarizeCredentialSecurity,
  type Credential,
  type CredentialSecuritySummary,
  type CredentialUrlHost,
} from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, DataTable, Field, Input, type Column } from '@/components/ui';

interface Manifest {
  savedAt: string;
  credentials: Credential[];
}

/** Automated-push state, from GET /api/system/credentials (#2519). */
interface VaultStatus {
  installed: boolean;
  configured: boolean;
  /** E-mail of the technical account, or null when not set up. */
  account?: string | null;
  lastSync: {
    at: string;
    ok: boolean;
    reason?: string;
    message?: string;
    secured?: number;
    attempted?: number;
  } | null;
}

const VAULT_UNKNOWN: VaultStatus = { installed: false, configured: false, account: null, lastSync: null };

/**
 * Why the not-yet-secured entries are still here (#2519).
 *
 * The point of this line is that "not secured" is never silent and never
 * ambiguous: not installed, not set up, or a push that actually failed
 * are three different sentences, and a failed push says so with the
 * reason the server recorded rather than degrading into a green state.
 */
function PushState({ vault }: { vault: VaultStatus }) {
  const last = vault.lastSync;
  let text: string;
  if (!vault.installed) {
    text = 'Vaultwarden isn’t installed on this box, so there is nowhere to push these to yet.';
  } else if (!vault.configured) {
    text = 'Automatic push is not set up — ServiceBay has no vault account of its own yet, so the hand-off below is manual.';
  } else if (last && !last.ok) {
    text = `Last push ${new Date(last.at).toLocaleString()} did not complete${last.message ? `: ${last.message}` : '.'}`;
  } else if (last?.ok) {
    text = `Last push ${new Date(last.at).toLocaleString()} secured ${last.secured ?? 0} of ${last.attempted ?? 0}.`;
  } else {
    text = 'Automatic push is set up but has not run yet.';
  }
  return (
    <p className="text-xs text-text-muted" data-testid="credentials-push-state">
      {text}
    </p>
  );
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
  cred: Credential;
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
function VaultLink({ href, title, children }: {
  href: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={'inline-flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-surface-muted ' +
        'text-text text-sm font-medium rounded-card border border-border transition-colors'}
    >
      <ExternalLink size={14} />
      {children}
    </a>
  );
}

/** The line that replaced the password column: where these secrets live. */
function SyncStatus({ summary, savedAt, vault }: {
  summary: CredentialSecuritySummary;
  savedAt: string;
  vault: VaultStatus;
}) {
  return (
    <div className="space-y-1">
      {summary.unsecured > 0 ? (
        <p className="text-sm text-status-warn" data-testid="credentials-sync-status">
          {summary.unsecured} of {summary.total} not yet secured — ServiceBay is still the only place
          {summary.unsecured === 1 ? ' this password lives' : ' these passwords live'}.
        </p>
      ) : (
        <p className="text-sm text-status-ok" data-testid="credentials-sync-status">
          All {summary.total} entries are in Vaultwarden
          {summary.lastSecuredAt ? ` — last synced ${new Date(summary.lastSecuredAt).toLocaleString()}` : ''}.
          ServiceBay no longer stores these passwords.
        </p>
      )}
      {summary.unsecured > 0 && <PushState vault={vault} />}
      <p className="text-xs text-text-muted">
        Last updated {new Date(savedAt).toLocaleString()}. Passwords are never shown here — open the entry
        in Vaultwarden.
      </p>
    </div>
  );
}

/** Hand-off actions. Which ones apply depends entirely on `summary.unsecured`. */
const TIP_CSV = 'Download the not-yet-secured credentials as a Vaultwarden-importable CSV.';
const TIP_IMPORT = 'Opens the Vaultwarden web-vault import page in a new tab. Download the CSV first, then pick it there \u2014 it imports into your personal vault.';
const TIP_CONFIRM = "Records the hand-off and deletes ServiceBay's copy of these passwords.";
const TIP_WIPE = 'Remove the whole list from ServiceBay, secured entries included.';
const TIP_PUSH = "Write the not-yet-secured entries into ServiceBay's Vaultwarden collection, then drop the local copy of each one the vault confirms.";

function CredentialActions({ summary, vaultBase, vault, busy, onDownload, onConfirmSecured, onWipe, onPush }: {
  summary: CredentialSecuritySummary;
  vaultBase: string | null;
  vault: VaultStatus;
  busy: 'wipe' | 'secure' | 'push' | null;
  onDownload: () => void;
  onConfirmSecured: () => void;
  onWipe: () => void;
  onPush: () => void;
}) {
  const pending = summary.unsecured > 0;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pending && vault.configured && (
        <Button onClick={onPush} disabled={busy === 'push'} variant="primary" size="md" title={TIP_PUSH}>
          {busy === 'push' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Push to Vaultwarden now
        </Button>
      )}
      {pending && (
        <Button onClick={onDownload} variant={vault.configured ? 'secondary' : 'primary'} size="md" title={TIP_CSV}>
          <Download size={14} />
          Download CSV
        </Button>
      )}
      {vaultBase && pending && (
        <VaultLink href={`${vaultBase}/#/tools/import`} title={TIP_IMPORT}>
          Open Vaultwarden import
        </VaultLink>
      )}
      {vaultBase && !pending && (
        <VaultLink href={`${vaultBase}/#/vault`}>Open in Vaultwarden</VaultLink>
      )}
      {pending && (
        <Button onClick={onConfirmSecured} disabled={busy === 'secure'} variant="secondary" size="md" title={TIP_CONFIRM}>
          {busy === 'secure' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          They&apos;re in Vaultwarden — drop the local copy
        </Button>
      )}
      <Button onClick={onWipe} disabled={busy === 'wipe'} variant="danger" size="md" title={TIP_WIPE}>
        {busy === 'wipe' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        Forget entries
      </Button>
    </div>
  );
}

const INPUT_CLASS =
  'w-full px-3 py-2 bg-surface-2 border border-border rounded-input text-text text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-accent';

const setupHeadline = (vault: VaultStatus) =>
  vault.configured
    ? `Automatic push writes to the shared collection as ${vault.account ?? 'the ServiceBay account'}.`
    : 'Set up automatic push: give ServiceBay its own Vaultwarden account and a shared collection.';

/** POST the account; returns an error message, or null on success. */
async function saveVaultAccount(form: VaultForm): Promise<string | null> {
  const res = await fetch('/api/system/credentials/vault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(form),
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.error || `HTTP ${res.status}`;
}

interface VaultForm {
  accountEmail: string;
  password: string;
  organizationId: string;
  collectionId: string;
}

/** The four values the operator copies out of the web vault. */
function VaultSetupFields({ form, set, configured, saving, onSave, vaultBase }: {
  form: VaultForm;
  set: (k: keyof VaultForm) => (e: React.ChangeEvent<HTMLInputElement>) => void;
  configured: boolean;
  saving: boolean;
  onSave: () => void;
  vaultBase: string | null;
}) {
  return (
    <div className="space-y-3">
      <Field label="ServiceBay account e-mail" help="A dedicated Vaultwarden account — never your own.">
        {p => <Input {...p} className={INPUT_CLASS} type="email" value={form.accountEmail} onChange={set('accountEmail')} placeholder="servicebay@your-domain" />}
      </Field>
      <Field
        label="Master password"
        help={configured ? 'Leave blank to keep the stored one.' : 'Generate a long random one — no human ever types it.'}
      >
        {p => <Input {...p} className={INPUT_CLASS} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />}
      </Field>
      <Field label="Organization ID" help="From the organization's URL in the web vault.">
        {p => <Input {...p} className={INPUT_CLASS} value={form.organizationId} onChange={set('organizationId')} />}
      </Field>
      <Field label="Collection ID" help="The collection ServiceBay files its entries into.">
        {p => <Input {...p} className={INPUT_CLASS} value={form.collectionId} onChange={set('collectionId')} />}
      </Field>
      <div className="flex items-center gap-2">
        <Button onClick={onSave} disabled={saving} variant="primary" size="md">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          Save vault account
        </Button>
        {vaultBase && <VaultLink href={`${vaultBase}/#/settings/organizations`}>Open Vaultwarden</VaultLink>}
      </div>
    </div>
  );
}

/**
 * Setup for the dedicated ServiceBay vault account (#2519).
 *
 * Provisioning the account, the organization and the collection is an
 * **operator step**, not something ServiceBay does for itself: creating
 * an account needs open signups, and putting the operator into the
 * organization afterwards needs an invitation they accept with their own
 * keys. An org only ServiceBay can read would be worse than no org.
 * `assists/recipe-vaultwarden-servicebay-push.md` walks the four minutes
 * of clicking; this form takes the result.
 *
 * The master password is write-only — it is never sent back to the
 * browser, so the field is blank on every load and an empty value on save
 * means "keep the stored one".
 */
function VaultSetupForm({ vault, vaultBase, onSaved }: {
  vault: VaultStatus;
  vaultBase: string | null;
  onSaved: () => Promise<unknown>;
}) {
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ accountEmail: '', password: '', organizationId: '', collectionId: '' });

  if (!vault.installed) return null;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const error = await saveVaultAccount(form);
      if (error) {
        addToast('error', 'Could not save the vault account', error);
        return;
      }
      setForm(f => ({ ...f, password: '' }));
      setOpen(false);
      await onSaved();
      addToast('success', 'Vault account saved', 'Use “Push to Vaultwarden now” to hand the pending entries over.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-border rounded-card p-3 space-y-3" data-testid="credentials-vault-setup">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-text">{setupHeadline(vault)}</p>
        <Button onClick={() => setOpen(o => !o)} variant="secondary" size="sm">
          {open ? 'Cancel' : vault.configured ? 'Change account' : 'Set up automatic push'}
        </Button>
      </div>
      {open && (
        <VaultSetupFields
          form={form}
          set={set}
          configured={vault.configured}
          saving={saving}
          onSave={save}
          vaultBase={vaultBase}
        />
      )}
    </div>
  );
}

function ServiceCell(c: Credential) {
  return (
    <div>
      {c.service}
      {c.importance === 'system' && (
        <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">system</span>
      )}
    </div>
  );
}

function StoredInCell(c: Credential) {
  if (!isCredentialSecured(c)) return <Badge variant="warn">Not yet secured</Badge>;
  return (
    <Badge variant="ok" title={`Handed off ${new Date(c.securedAt!).toLocaleString()}`}>
      Vaultwarden
    </Badge>
  );
}

/** Explicit per-column widths (#2520): without them the browser's auto
 *  table-layout hands the spare width to whichever column holds the longest
 *  prose — Notes — and starves Service/URL/Username. These are preferred
 *  widths, so a column still grows past its share rather than clipping; the
 *  table's min-width makes a narrow viewport scroll instead of crushing them. */
function credentialColumns(
  proxyHosts: CredentialUrlHost[],
  publicDomain: string | null,
): Column<Credential>[] {
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
    // "Stored in" replaces the old Password column (#2519): where the secret
    // lives, never the secret itself.
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
 * Settings → Saved credentials (#2519).
 *
 * This section used to be a password table: a Password column with
 * per-row reveal + copy, i.e. a second password manager next to the
 * Vaultwarden ServiceBay itself deploys. It no longer renders secrets at
 * all. What it shows instead is **where each credential lives**:
 *
 *   - "In Vaultwarden" — the hand-off happened and ServiceBay dropped its
 *     copy of the password; only the pointer (service/URL/username) is left.
 *   - "Not yet secured" — ServiceBay is still the only place this secret
 *     exists. That is the state to act on, and it is called out at the top,
 *     including when Vaultwarden isn't installed on this box at all.
 *
 * Hand-off happens two ways. When ServiceBay has its own vault account
 * (`config.credentialVault`), "Push to Vaultwarden now" — and every
 * install — writes the entries into the shared organization collection,
 * reads each one back, and drops the local password only for the ones the
 * vault confirmed. Without that account the manual route remains: CSV →
 * import → confirm, which calls `/api/system/credentials/secured`.
 *
 * A write into the operator's *personal* vault is not an option in either
 * mode — it would need their master password. See
 * `assists/footgun-vaultwarden-personal-vault-write.md`.
 */
export default function CredentialsSection() {
  const { addToast } = useToast();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [proxyHosts, setProxyHosts] = useState<CredentialUrlHost[]>([]);
  const [publicDomain, setPublicDomain] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultStatus>(VAULT_UNKNOWN);
  const [busy, setBusy] = useState<'load' | 'wipe' | 'secure' | 'push' | null>('load');

  const load = () =>
    fetch('/api/system/credentials')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) {
          setManifest(data.manifest ?? null);
          setProxyHosts(Array.isArray(data.proxyHosts) ? data.proxyHosts : []);
          setPublicDomain(data.publicDomain ?? null);
          setVault(data.vault ?? VAULT_UNKNOWN);
        }
      });

  useEffect(() => {
    // Mount-only: the section re-reads on demand after a push/wipe.
    load().finally(() => setBusy(null));
  }, []);

  const credentials = useMemo(() => manifest?.credentials ?? [], [manifest]);
  const summary = useMemo(() => summarizeCredentialSecurity(credentials), [credentials]);
  const urlCtx = { hosts: proxyHosts, publicDomain: publicDomain ?? undefined };

  // Vaultwarden deep links (#1627/#2519): only when vaultwarden is installed
  // (has a proxy host). Derive the domain from the proxy host so we don't
  // hardcode `vault`/the public domain.
  const vaultHost = proxyHosts.find(h => h.service === 'vaultwarden');
  const vaultBase = vaultHost?.domain ? `https://${vaultHost.domain}` : null;

  const onConfirmSecured = async () => {
    if (!window.confirm(
      `Confirm ${summary.unsecured} credential(s) are now in Vaultwarden?\n\n` +
      'ServiceBay deletes its own copy of these passwords immediately. The services keep running with the same passwords — but if they are not actually in your vault, the only way back is to reset them in each service.',
    )) return;
    setBusy('secure');
    try {
      const res = await fetch('/api/system/credentials/secured', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Could not record the hand-off', data.error || `HTTP ${res.status}`);
        return;
      }
      const securedAt: string = data.securedAt ?? new Date().toISOString();
      setManifest(m => (m ? {
        savedAt: securedAt,
        credentials: m.credentials.map(c =>
          isCredentialSecured(c) ? c : { ...c, password: '', securedAt }),
      } : m));
      addToast('success', 'Vaultwarden is now the only copy', `${data.secured ?? summary.unsecured} password(s) dropped from ServiceBay.`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Run the automated push (#2519). The server drops a local password
   * only for an entry it wrote AND read back, so a partial result is a
   * normal outcome — reload and let the table show which entries are
   * still unsecured rather than claiming success.
   */
  const onPush = async () => {
    setBusy('push');
    try {
      const res = await fetch('/api/system/credentials/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      await load();
      if (!res.ok) {
        addToast('error', 'Push failed', data.error || `HTTP ${res.status}`);
        return;
      }
      if (data.ok) {
        addToast('success', 'Pushed to Vaultwarden', `${data.secured ?? 0} entry(ies) confirmed in the vault; ServiceBay dropped its copy.`);
      } else {
        addToast(
          'error',
          `Not secured — ${data.secured ?? 0} of ${data.attempted ?? 0} confirmed`,
          data.message || 'ServiceBay kept the passwords it could not confirm in the vault.',
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const onWipe = async () => {
    if (!window.confirm(
      'Forget these entries entirely?\n\n' +
      'This removes the whole list, including the not-yet-secured passwords — make sure you have them saved first. The credentials themselves remain in the running services; this only clears ServiceBay\'s record.',
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
      addToast('success', 'Entries forgotten', 'Services keep running with the same passwords — they just aren\'t in ServiceBay\'s config anymore.');
    } finally {
      setBusy(null);
    }
  };

  const downloadCsv = () => {
    if (summary.unsecured === 0) return;
    const blob = new Blob([buildBitwardenCsv(credentials, urlCtx)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `servicebay-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    addToast('success', 'Credentials CSV downloaded', 'Import it into Vaultwarden, then confirm below so ServiceBay drops its copy.');
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
        <SyncStatus summary={summary} savedAt={manifest!.savedAt} vault={vault} />
      )}

      {summary.total > 0 && (
        <CredentialActions
          summary={summary}
          vaultBase={vaultBase}
          vault={vault}
          busy={busy}
          onDownload={downloadCsv}
          onConfirmSecured={onConfirmSecured}
          onWipe={onWipe}
          onPush={onPush}
        />
      )}

      {summary.total > 0 && (
        <VaultSetupForm vault={vault} vaultBase={vaultBase} onSaved={load} />
      )}

      <div>
        {summary.total === 0 ? (
          <p className="text-sm text-text-muted italic">
            Nothing saved yet. The install wizard writes here at the end of every successful run.
          </p>
        ) : (
          <DataTable<Credential>
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
