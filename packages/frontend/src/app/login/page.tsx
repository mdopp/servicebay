'use client';

// useSearchParams forces dynamic rendering. Mark the page so static export
// at build time doesn't try to pre-render and fail.
export const dynamic = 'force-dynamic';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ServiceBayLogo from '@/components/ServiceBayLogo';
import { Code, ArrowRight, Loader2, Shield, AlertTriangle } from 'lucide-react';
import { fetchOidcStatus, login as loginRequest, TypedFetchError } from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';
import pkg from '../../../package.json';

const OIDC_ERRORS: Record<string, string> = {
  oidc_denied: 'Authentication was denied by the identity provider.',
  oidc_invalid: 'Invalid OIDC response. Please try again.',
  oidc_state: 'Session expired. Please try again.',
  oidc_token: 'Failed to exchange authorization code.',
  oidc_forbidden: 'Your account does not have access to ServiceBay.',
  oidc_error: 'An unexpected SSO error occurred.',
};

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { addToast } = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const detectCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLock(e.getModifierState('CapsLock'));
    }
  };

  useEffect(() => {
    // Check if OIDC is available
    fetchOidcStatus()
      .then(data => setOidcEnabled(data.enabled))
      .catch(() => {});

    // Show OIDC error if present
    const error = searchParams.get('error');
    if (error && OIDC_ERRORS[error]) {
      addToast('error', 'SSO Login Failed', OIDC_ERRORS[error]);
    }
  }, [searchParams, addToast]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Goes through the typed api-client (apiFetch under the hood), which
      // is safe here even on a failed login: `/login` is one of apiFetch's
      // ANONYMOUS_PATHS, so a 401 response never triggers its 401 → /login
      // redirect while we're already on this page.
      await loginRequest(username, password);
      router.push('/services');
      router.refresh();
    } catch (e) {
      if (e instanceof TypedFetchError) {
        // A real HTTP response came back (invalid credentials, rate-limited,
        // not-configured) — `TypedFetchError`'s message is the server's own
        // `{ error }` text (see rawApi's rawErrorMessage).
        addToast('error', 'Login failed', e.message || 'Invalid credentials');
      } else {
        addToast('error', 'Login error', 'An unexpected error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-surface p-4">
      <div className="w-full max-w-md bg-surface rounded-xl shadow-lg border border-border overflow-hidden">

        {/* Header */}
        <div className="p-8 text-center border-b border-border bg-surface/50">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-surface-2 rounded-full">
                <ServiceBayLogo size={48} className="text-accent" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-text mb-1">ServiceBay</h1>
          <p className="text-sm text-text-muted font-medium">by Korgraph.io - v{pkg.version}</p>
        </div>

        {/* Content */}
        <div className="p-8">
          <p className="text-center text-text-muted mb-8 text-sm leading-relaxed">
            Manage your Podman Quadlet services, monitor containers, and access the terminal directly from your browser.
          </p>

          {oidcEnabled && (
            <>
              <a
                href="/api/auth/oidc"
                className="w-full py-2.5 px-4 bg-accent hover:bg-accent-strong text-on-accent font-medium rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
              >
                <Shield size={18} />
                Login with SSO
              </a>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-surface text-text-muted">or</span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent focus:border-transparent outline-none transition-all"
                placeholder="System username"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={detectCapsLock}
                onKeyUp={detectCapsLock}
                onBlur={() => setCapsLock(false)}
                className="w-full px-4 py-2 rounded-lg border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent focus:border-transparent outline-none transition-all"
                placeholder="System password"
                autoComplete="current-password"
                required
              />
              {capsLock && (
                <p className="mt-1 flex items-center gap-1 text-xs text-status-warn" role="alert">
                  <AlertTriangle size={12} /> Caps Lock is on
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-accent hover:bg-accent-strong text-on-accent font-medium rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 size={20} className="animate-spin" /> : <>Login <ArrowRight size={18} /></>}
            </button>
          </form>
          <p className="text-center text-xs text-text-muted mt-4">
            {oidcEnabled
              ? 'Use your admin credentials or login with SSO above.'
              : 'Use the admin credentials configured during first start.'}
          </p>
        </div>

        {/* Footer */}
        <div className="p-4 bg-surface border-t border-border flex justify-center">
          <a
            href="https://github.com/mdopp/servicebay"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text transition-colors"
          >
            <Code size={16} />
            <span>View on GitHub</span>
          </a>
        </div>
      </div>
    </div>
  );
}
