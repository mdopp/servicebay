'use client';

import { useEffect, useState } from 'react';
import { Download, ExternalLink, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';
import {
  buildBitwardenCsv,
  isHttpUrl,
  resolveCredentialUrl,
  type Credential,
  type CredentialUrlHost,
} from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';
import { Button, DataTable } from '@/components/ui';

interface Manifest {
  savedAt: string;
  credentials: Credential[];
}

/** URL cell (#1626): render an admin-reachable http(s) URL as a clickable
 *  link; render non-URL hints (`env:`, `\\…`, `ssh://`, bearer tokens) as
 *  plain text. The loopback→public-subdomain rewrite happens in
 *  `resolveCredentialUrl`. */
function CredentialUrlCell({ cred, hosts, publicDomain }: {
  cred: Credential;
  hosts: CredentialUrlHost[];
  publicDomain: string | null;
}) {
  const resolved = resolveCredentialUrl(cred, { hosts, publicDomain: publicDomain ?? undefined });
  if (!isHttpUrl(resolved)) return <span className="break-all">{resolved}</span>;
  return (
    <a
      href={resolved}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline break-all"
    >
      {resolved}
    </a>
  );
}

/**
 * Settings section that surfaces the encrypted credentials manifest
 * the install wizard persisted (#19 / A1). Encrypted at rest in
 * `config.json`; decrypted by the same admin session that's loading
 * this page.
 *
 * Two affordances:
 *   - Per-row password reveal (default hidden) so the page doesn't
 *     leak secrets at a glance to anyone shoulder-surfing.
 *   - "Wipe from server" button that clears the manifest after the
 *     operator has stored credentials in their password manager —
 *     narrows the window during which plaintext-decryptable secrets
 *     sit in config.json.
 */
export default function CredentialsSection() {
  const { addToast } = useToast();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [proxyHosts, setProxyHosts] = useState<CredentialUrlHost[]>([]);
  const [publicDomain, setPublicDomain] = useState<string | null>(null);
  const [busy, setBusy] = useState<'load' | 'wipe' | null>('load');
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    fetch('/api/system/credentials')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data) {
          setManifest(data.manifest ?? null);
          setProxyHosts(Array.isArray(data.proxyHosts) ? data.proxyHosts : []);
          setPublicDomain(data.publicDomain ?? null);
        }
      })
      .finally(() => setBusy(null));
  }, []);

  const urlCtx = { hosts: proxyHosts, publicDomain: publicDomain ?? undefined };

  // Vaultwarden import deep-link (#1627): only when vaultwarden is installed
  // (has a proxy host) and a public domain is configured. Derive the domain
  // from the proxy host so we don't hardcode `vault`/the public domain.
  const vaultHost = proxyHosts.find(h => h.service === 'vaultwarden');
  const vaultwardenImportUrl =
    publicDomain && vaultHost?.domain
      ? `https://${vaultHost.domain}/#/tools/import`
      : null;

  const onWipe = async () => {
    if (!window.confirm(
      'Wipe credentials from the server?\n\n' +
      'Make sure you\'ve already saved them in your password manager — once wiped, you\'ll need to dig them out of running services manually (or reinstall) to recover.\n\n' +
      'The credentials themselves remain in the running services; this only clears ServiceBay\'s saved copy.',
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
      addToast('success', 'Credentials wiped from server', 'The saved manifest is gone. Services keep running with the same passwords — they just aren\'t in ServiceBay\'s config anymore.');
    } finally {
      setBusy(null);
    }
  };

  const downloadCsv = () => {
    if (!manifest || manifest.credentials.length === 0) return;
    const blob = new Blob([buildBitwardenCsv(manifest.credentials, urlCtx)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `servicebay-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    addToast('success', 'Credentials CSV downloaded', 'Re-import it into Bitwarden/Vaultwarden, then consider wiping the server copy.');
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
        {manifest && (
          <p className="text-xs text-text-muted">
            Persisted at {new Date(manifest.savedAt).toLocaleString()} — encrypted at rest, visible to logged-in admins.
          </p>
        )}
        {manifest && manifest.credentials.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={downloadCsv}
              variant="primary"
              size="md"
              title="Download the saved credentials as a Bitwarden/Vaultwarden-importable CSV."
            >
              <Download size={14} />
              Download CSV
            </Button>
            {vaultwardenImportUrl && (
              <a
                href={vaultwardenImportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-surface-muted text-text text-sm font-medium rounded-card border border-border transition-colors"
                title="Opens the Vaultwarden web-vault import page in a new tab. Download the CSV first, then pick it there. Choose an Organization collection to share entries with other admins (folders are personal)."
              >
                <ExternalLink size={14} />
                Open Vaultwarden import
              </a>
            )}
            <Button
              onClick={onWipe}
              disabled={busy === 'wipe'}
              variant="danger"
              size="md"
              title="Remove the saved credentials from the server. Useful once you've stored them safely in your password manager."
            >
              {busy === 'wipe' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Wipe from server
            </Button>
          </div>
        )}

      <div>
        {!manifest || manifest.credentials.length === 0 ? (
          <p className="text-sm text-text-muted italic">
            Nothing saved yet. The install wizard writes here at the end of every successful run.
          </p>
        ) : (
          <DataTable<Credential>
            columns={[
              {
                key: 'service',
                header: 'Service',
                cell: (c) => (
                  <div>
                    {c.service}
                    {c.importance === 'system' && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">system</span>
                    )}
                  </div>
                ),
                align: 'left',
              },
              {
                key: 'url',
                header: 'URL',
                cell: (c) => <CredentialUrlCell cred={c} hosts={proxyHosts} publicDomain={publicDomain} />,
                align: 'left',
                className: 'font-mono text-xs',
              },
              {
                key: 'username',
                header: 'Username',
                cell: (c) => c.username,
                align: 'left',
                className: 'font-mono text-xs',
              },
              {
                key: 'password',
                header: 'Password',
                cell: (c, i) => {
                  const isRevealed = !!revealed[i];
                  return (
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs">{isRevealed ? c.password : '••••••••••'}</code>
                      <Button
                        onClick={() => setRevealed(s => ({ ...s, [i]: !s[i] }))}
                        variant="ghost"
                        className="!h-auto !p-1"
                        title={isRevealed ? 'Hide password' : 'Reveal password'}
                      >
                        {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                      </Button>
                      {isRevealed && (
                        <Button
                          onClick={() => {
                            navigator.clipboard.writeText(c.password).then(
                              () => addToast('success', 'Copied to clipboard', `${c.service} password`),
                              () => addToast('error', 'Copy failed', 'Browser refused clipboard access.'),
                            );
                          }}
                          variant="ghost"
                          className="!h-auto !p-1 text-[10px] uppercase tracking-wide"
                        >
                          copy
                        </Button>
                      )}
                    </div>
                  );
                },
                align: 'left',
              },
              {
                key: 'notes',
                header: 'Notes',
                cell: (c) => c.notes ?? '',
                align: 'left',
                className: 'text-xs text-text-muted',
              },
            ]}
            rows={manifest.credentials}
            rowKey={(c, i) => String(i)}
            rowClassName={(c) =>
              c.importance === 'critical' ? '' : 'opacity-80'
            }
            empty="No credentials saved"
          />
        )}
      </div>
    </>
  );
}
