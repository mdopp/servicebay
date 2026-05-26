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
      <div className="mt-12 max-w-md mx-auto text-center bg-amber-50/70 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/40 rounded-2xl p-6">
        <Clock size={28} className="mx-auto text-amber-600 dark:text-amber-400" />
        <h2 className="mt-3 text-lg font-bold text-gray-900 dark:text-white">
          Your access request is being reviewed
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
          {fetched.firstName ? `Hi ${fetched.firstName} — ` : ''}we&apos;ll email you as soon as the family admin sets your account up. No action needed from you right now.
        </p>
      </div>
    );
  }

  if (fetched.status === 'resolved') {
    const buttonClasses = 'inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg transition-colors';
    return (
      <div className="mt-12 max-w-md mx-auto text-center bg-emerald-50/70 dark:bg-emerald-900/10 border border-emerald-200/60 dark:border-emerald-800/40 rounded-2xl p-6">
        <KeyRound size={28} className="mx-auto text-emerald-600 dark:text-emerald-400" />
        <h2 className="mt-3 text-lg font-bold text-gray-900 dark:text-white">
          {fetched.firstName ? `Welcome, ${fetched.firstName}!` : 'Your account is ready'}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
          {fetched.username
            ? <>Your username is <span className="font-mono">{fetched.username}</span>. Set your password to sign in:</>
            : <>Set your password to sign in:</>}
        </p>
        <div className="mt-4">
          {fetched.authUrl
            ? (
              <a href={fetched.authUrl} className={buttonClasses}>
                Set your password
              </a>
            )
            : (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                Open your welcome email — it includes the password-set link.
              </p>
            )}
        </div>
      </div>
    );
  }

  return <>{fallback}</>;
}
