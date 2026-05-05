'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, Shield, XCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

export default function ReverseProxySection() {
  const { addToast } = useToast();
  const [configured, setConfigured] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adminUrl, setAdminUrl] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'forget' | null>('load');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/system/nginx/credentials');
        if (res.ok) {
          const data = await res.json();
          setConfigured(Boolean(data.configured));
          setEmail(data.email || '');
        }
      } finally {
        setBusy(null);
      }
    })();
  }, []);

  const handleSave = async () => {
    setBusy('save');
    try {
      const res = await fetch('/api/system/nginx/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          adminUrl: adminUrl || undefined,
          test: Boolean(adminUrl),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Could not save credentials', data.error || `HTTP ${res.status}`);
      } else {
        addToast('success', 'NPM credentials saved', adminUrl ? 'Tested and stored.' : 'Stored without testing (no admin URL provided).');
        setConfigured(true);
        setPassword('');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleForget = async () => {
    setBusy('forget');
    try {
      const res = await fetch('/api/system/nginx/credentials', { method: 'DELETE' });
      if (res.ok) {
        setConfigured(false);
        setEmail('');
        setPassword('');
        addToast('success', 'NPM credentials removed');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg text-emerald-600 dark:text-emerald-400">
          <Shield size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Reverse Proxy (NPM)</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Store Nginx Proxy Manager admin credentials so ServiceBay can auto-sync proxy routes during service install/update without prompting.
          </p>
        </div>
        <div className="shrink-0">
          {configured ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40 px-2 py-1 rounded">
              <CheckCircle2 size={12} /> Stored
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
              <XCircle size={12} /> Not configured
            </span>
          )}
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Admin email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={busy !== null}
              autoComplete="off"
              className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none"
              placeholder="admin@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Admin password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy !== null}
                autoComplete="new-password"
                className="w-full p-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                placeholder={configured ? '•••••••• (leave blank to keep)' : ''}
              />
              <button
                type="button"
                onClick={() => setShowPassword(s => !s)}
                className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                title={showPassword ? 'Hide' : 'Show'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              NPM admin URL <span className="text-gray-400 font-normal">(optional, for credential test)</span>
            </label>
            <input
              type="text"
              value={adminUrl}
              onChange={e => setAdminUrl(e.target.value)}
              disabled={busy !== null}
              className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none"
              placeholder="http://nginx-host:81"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              When set, ServiceBay verifies the credentials against NPM before saving.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={busy !== null || !email || !password}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm font-medium inline-flex items-center gap-2"
          >
            {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
            {adminUrl ? 'Test & Save' : 'Save'}
          </button>
          {configured && (
            <button
              onClick={handleForget}
              disabled={busy !== null}
              className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {busy === 'forget' && <Loader2 className="w-4 h-4 animate-spin inline mr-1" />}
              Forget credentials
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
