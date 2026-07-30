'use client';

import { useEffect, useState } from 'react';

/**
 * DNS-resolution check shown on the wizard's Done step. Replaces the
 * static "Create A records pointing to <SERVER-IP>" list with a real
 * lookup: if every subdomain already resolves to this server's public
 * (or LAN) IP, we just say "✓ DNS configured" and move on. If some
 * domains aren't pointing here yet, we show only those — operator
 * doesn't need to read a list of A records they already created.
 *
 * Uses POST /api/system/dns/verify which does the public-resolver
 * lookup server-side (so the browser doesn't have to talk to a public
 * DNS resolver from inside the LAN).
 */
interface DoneStepDnsCheckProps {
  /** Public domain (e.g. dopp.cloud) — only used for empty-state copy. */
  domain: string;
  /** Fully-qualified subdomains to verify (e.g. ['vault.dopp.cloud', …]). */
  subdomains: string[];
}

interface DomainResult {
  domain: string;
  resolvesTo: string | null;
  matches: boolean;
  error?: string;
}

interface VerifyResponse {
  expectedIPs: string[];
  results: DomainResult[];
}

export function DoneStepDnsCheck({ domain, subdomains }: DoneStepDnsCheckProps) {
  // Initial state already differentiates "nothing to verify" from "loading"
  // — keeps the effect's only job to "fire fetch + handle response", which
  // satisfies the react-hooks/set-state-in-effect lint rule.
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; data: VerifyResponse }
  >(
    subdomains.length === 0
      ? { phase: 'ready', data: { expectedIPs: [], results: [] } }
      : { phase: 'loading' },
  );

  useEffect(() => {
    if (subdomains.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/dns/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domains: subdomains }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ phase: 'error', message: `HTTP ${res.status}` });
          return;
        }
        const data = (await res.json()) as VerifyResponse;
        if (cancelled) return;
        setState({ phase: 'ready', data });
      } catch (e) {
        if (cancelled) return;
        setState({ phase: 'error', message: e instanceof Error ? e.message : 'fetch failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [subdomains]);

  if (state.phase === 'loading') {
    return (
      <div className="p-2.5 bg-surface rounded border border-border text-sm">
        <p className="text-xs text-text-muted">⏳ Checking DNS for {subdomains.length} host{subdomains.length === 1 ? '' : 's'}…</p>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="p-2.5 bg-status-warn/10 rounded border border-status-warn text-sm space-y-1.5">
        <p className="font-medium text-status-warn">DNS check unavailable</p>
        <p className="text-xs text-status-warn">
          Couldn&apos;t verify DNS automatically: {state.message}. Make sure each subdomain has an A record pointing to your server&apos;s public IP.
        </p>
      </div>
    );
  }

  // Defensive defaults — a stub server response (or older API version)
  // could omit either field. Render the empty case below rather than
  // crash the whole Done step.
  const expectedIPs = Array.isArray(state.data.expectedIPs) ? state.data.expectedIPs : [];
  const results = Array.isArray(state.data.results) ? state.data.results : [];
  const matched = results.filter(r => r.matches);
  const unmatched = results.filter(r => !r.matches);
  const allMatched = unmatched.length === 0 && results.length > 0;
  if (results.length === 0) return null;

  if (allMatched) {
    return (
      <div className="p-2.5 bg-status-ok/10 rounded border border-status-ok text-sm space-y-1.5">
        <p className="font-medium text-status-ok">
          ✓ DNS configured for all {results.length} host{results.length === 1 ? '' : 's'}
        </p>
        <p className="text-xs text-status-ok">
          Every subdomain already resolves to {expectedIPs.length === 1 ? expectedIPs[0] : `your server (${expectedIPs.join(' or ')})`}.
        </p>
      </div>
    );
  }

  // Partial / no match — show what needs to change.
  return (
    <div className="p-2.5 bg-status-info/10 rounded border border-status-info text-sm space-y-1.5">
      <p className="font-medium text-status-info">
        Configure DNS for {unmatched.length} host{unmatched.length === 1 ? '' : 's'}
        {matched.length > 0 ? ` (${matched.length} already pointing here ✓)` : ''}
      </p>
      <p className="text-xs text-status-info">
        Add A records pointing to {expectedIPs.length > 0
          ? expectedIPs.join(' (or ')
          : <span>your server&apos;s public IP</span>}
        {expectedIPs.length > 1 ? ')' : ''}:
      </p>
      <div className="font-mono text-xs text-status-info space-y-0.5">
        {unmatched.map(r => (
          <div key={r.domain}>
            {r.domain} &rarr;{' '}
            {r.resolvesTo
              ? <span className="text-status-warn">currently {r.resolvesTo}</span>
              : <span className="text-text-muted">not resolving{r.error ? ` (${r.error})` : ''}</span>
            }
          </div>
        ))}
      </div>
      <p className="text-[11px] text-status-info opacity-70 pt-1">
        Lookup uses a public resolver — once your DNS provider has propagated the change, the warning here clears on the next reload.
      </p>
      {/* Suppress unused-prop warning while keeping the prop in the public API. */}
      <span className="hidden">{domain}</span>
    </div>
  );
}
