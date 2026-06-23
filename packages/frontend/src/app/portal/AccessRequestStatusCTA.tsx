'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Clock, KeyRound } from 'lucide-react';

/**
 * State-aware CTA on /portal for visitors who submitted an access
 * request — covers the two non-default cases from #1001:
 *
 *   - pending  → "Your request is being reviewed — check your email"
 *   - resolved → "Welcome, <name>! Set your password →"  (deep-links
 *                to https://auth.<domain>/ where the visitor clicks
 *                Forgot password to enroll, mirroring the welcome
 *                email's instructions)
 *
 * Stores `{ id, submittedAt }` in localStorage at submit time (see
 * RequestAccessButton.tsx). On mount we read it back, GET the
 * public status endpoint, and render the matching block. The
 * generic Request-access button stays the fallback when there's no
 * stored id, the lookup returns `not-found` (admin cleared the
 * request, or stale localStorage from a different device), or the
 * fetch fails.
 *
 * useSyncExternalStore reads the stored id at render time without
 * triggering the setState-in-effect lint rule that PortalGrid +
 * PortalLogoutLink use the same pattern for.
 */

interface PortalAccessRequestRecord {
  id: string;
  submittedAt: string;
}

type StatusResponse =
  | { status: 'not-found' }
  | { status: 'pending'; firstName?: string; requestedAt?: string }
  | { status: 'resolved'; firstName?: string; username?: string; resolvedAt?: string; authUrl?: string | null };

const STORAGE_KEY = 'sb.portal.lastAccessRequest';

const noopSubscribe = () => () => {};

function readStoredRequest(): PortalAccessRequestRecord | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PortalAccessRequestRecord;
    if (!parsed?.id || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearStoredRequest(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
}

export default function AccessRequestStatusCTA({ fallback }: { fallback: React.ReactNode }) {
  const stored = useSyncExternalStore(noopSubscribe, readStoredRequest, () => null);
  const [fetched, setFetched] = useState<StatusResponse | null>(null);

  useEffect(() => {
    if (!stored) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/system/access-requests/${encodeURIComponent(stored.id)}/status`, {
          cache: 'no-store',
        });
        const data = res.ok
          ? ((await res.json()) as StatusResponse)
          : ({ status: 'not-found' } as StatusResponse);
        if (!cancelled) setFetched(data);
        if (data.status === 'not-found') clearStoredRequest();
      } catch {
        if (!cancelled) setFetched({ status: 'not-found' });
      }
    })();
    return () => { cancelled = true; };
  }, [stored]);

  if (!stored) return <>{fallback}</>;
  // While the fetch is in-flight, render nothing — avoids flicker
  // between the fallback CTA and the eventual pending/resolved
  // block. The portal already has the welcome header above.
  if (!fetched) return null;

  if (fetched.status === 'pending') {
    return (
      <div className="mt-space-7 max-w-md mx-auto text-center bg-status-warn/10 border border-status-warn/40 rounded-card p-space-5">
        <Clock size={28} className="mx-auto text-status-warn" />
        <h2 className="mt-space-3 text-lg font-bold text-text">
          Your access request is being reviewed
        </h2>
        <p className="mt-space-2 text-sm text-text-muted leading-relaxed">
          {fetched.firstName ? `Hi ${fetched.firstName} — ` : ''}we&apos;ll email you as soon as the family admin sets your account up. No action needed from you right now.
        </p>
      </div>
    );
  }

  if (fetched.status === 'resolved') {
    const buttonClasses = 'inline-flex items-center justify-center gap-space-2 px-space-4 py-2.5 bg-accent hover:bg-accent-strong text-on-accent text-sm font-semibold rounded-card transition-colors';
    return (
      <div className="mt-space-7 max-w-md mx-auto text-center bg-status-ok/10 border border-status-ok/40 rounded-card p-space-5">
        <KeyRound size={28} className="mx-auto text-status-ok" />
        <h2 className="mt-space-3 text-lg font-bold text-text">
          {fetched.firstName ? `Welcome, ${fetched.firstName}!` : 'Your account is ready'}
        </h2>
        <p className="mt-space-2 text-sm text-text-muted leading-relaxed">
          {fetched.username
            ? <>Your username is <span className="font-mono">{fetched.username}</span>. Set your password to sign in:</>
            : <>Set your password to sign in:</>}
        </p>
        <div className="mt-space-4">
          {fetched.authUrl
            ? (
              <a href={fetched.authUrl} className={buttonClasses}>
                Set your password
              </a>
            )
            : (
              <p className="text-xs text-text-subtle italic">
                Open your welcome email — it includes the password-set link.
              </p>
            )}
        </div>
      </div>
    );
  }

  return <>{fallback}</>;
}
