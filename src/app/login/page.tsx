'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ServiceBayLogo from '@/components/ServiceBayLogo';
import { Github, ArrowRight, Loader2, Shield } from 'lucide-react';
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

  useEffect(() => {
    // Check if OIDC is available
    fetch('/api/auth/oidc/status')
      .then(res => res.json())
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
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok) {
        router.push('/services');
        router.refresh();
      } else {
        addToast('error', 'Login failed', data.error || 'Invalid credentials');
      }
    } catch {
      addToast('error', 'Login error', 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">

        {/* Header */}
        <div className="p-8 text-center border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                <ServiceBayLogo size={48} className="text-blue-600 dark:text-blue-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">ServiceBay</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">by Korgraph.io - v{pkg.version}</p>
        </div>

        {/* Content */}
        <div className="p-8">
          <p className="text-center text-gray-600 dark:text-gray-300 mb-8 text-sm leading-relaxed">
            Manage your Podman Quadlet services, monitor containers, and access the terminal directly from your browser.
          </p>

          {oidcEnabled && (
            <>
              <a
                href="/api/auth/oidc"
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
              >
                <Shield size={18} />
                Login with SSO
              </a>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200 dark:border-gray-700" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">or</span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                placeholder="System username"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                placeholder="System password"
                autoComplete="current-password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 size={20} className="animate-spin" /> : <>Login <ArrowRight size={18} /></>}
            </button>
          </form>
          <p className="text-center text-xs text-gray-400 dark:text-gray-500 mt-4">
            {oidcEnabled
              ? 'Use your admin credentials or login with SSO above.'
              : 'Use your system (Linux) username and password to log in.'}
          </p>
        </div>

        {/* Footer */}
        <div className="p-4 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-100 dark:border-gray-700 flex justify-center">
          <a
            href="https://github.com/mdopp/servicebay"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 transition-colors"
          >
            <Github size={16} />
            <span>View on GitHub</span>
          </a>
        </div>
      </div>
    </div>
  );
}
