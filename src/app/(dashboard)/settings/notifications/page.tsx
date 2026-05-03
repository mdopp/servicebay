'use client';

import { useState } from 'react';
import { Mail, Plus, Trash2 } from 'lucide-react';
import { useSettings } from '../_lib/SettingsContext';

export default function NotificationsSettingsPage() {
  const {
    saving,
    emailEnabled,
    setEmailEnabled,
    emailHost,
    setEmailHost,
    emailPort,
    setEmailPort,
    emailSecure,
    setEmailSecure,
    emailUser,
    setEmailUser,
    emailPass,
    setEmailPass,
    emailFrom,
    setEmailFrom,
    emailRecipients,
    setEmailRecipients,
    persistSettings,
  } = useSettings();

  const [newRecipient, setNewRecipient] = useState('');

  const handleAddRecipient = () => {
    if (newRecipient && !emailRecipients.includes(newRecipient)) {
      const updated = [...emailRecipients, newRecipient];
      setEmailRecipients(updated);
      setNewRecipient('');
      void persistSettings({ email: { to: updated } });
    }
  };

  const handleRemoveRecipient = (email: string) => {
    const updated = emailRecipients.filter(e => e !== email);
    setEmailRecipients(updated);
    void persistSettings({ email: { to: updated } });
  };

  const handleEmailEnabledToggle = (enabled: boolean) => {
    setEmailEnabled(enabled);
    void persistSettings({ email: { enabled } });
  };

  const handleEmailSecureToggle = (secure: boolean) => {
    setEmailSecure(secure);
    void persistSettings({ email: { secure } });
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
          <Mail size={20} />
        </div>
        <div>
          <h3 className="font-bold text-gray-900 dark:text-white">Email Notifications</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Configure SMTP settings for alerts</p>
        </div>
        <div className="ml-auto">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={emailEnabled}
              onChange={e => handleEmailEnabledToggle(e.target.checked)}
              disabled={saving}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>
      </div>

      {emailEnabled && (
        <div className="p-6 space-y-6">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium mb-1">Need help finding these settings?</p>
            <ul className="list-disc list-inside space-y-1 opacity-90">
              <li><strong>Gmail:</strong> Host: <code>smtp.gmail.com</code>, Port: <code>587</code>. Use an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-600">App Password</a> if 2FA is enabled.</li>
              <li><strong>Outlook:</strong> Host: <code>smtp.office365.com</code>, Port: <code>587</code>.</li>
              <li><strong>GMX:</strong> Host: <code>mail.gmx.net</code>, Port: <code>587</code>.</li>
            </ul>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Host</label>
              <input
                type="text"
                value={emailHost}
                onChange={e => setEmailHost(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="smtp.gmail.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Port</label>
              <input
                type="number"
                value={emailPort}
                onChange={e => setEmailPort(parseInt(e.target.value) || 0)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="587"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
              <input
                type="text"
                value={emailUser}
                onChange={e => setEmailUser(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
              <input
                type="password"
                value={emailPass}
                onChange={e => setEmailPass(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="••••••••"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">From Address</label>
              <input
                type="text"
                value={emailFrom}
                onChange={e => setEmailFrom(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="ServiceBay <alerts@example.com>"
              />
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={emailSecure}
                  onChange={e => handleEmailSecureToggle(e.target.checked)}
                  disabled={saving}
                  className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Use Secure Connection (TLS/SSL)</span>
              </label>
            </div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Recipients</label>
            <div className="flex gap-2 mb-3">
              <input
                type="email"
                value={newRecipient}
                onChange={e => setNewRecipient(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddRecipient()}
                disabled={saving}
                className="flex-1 p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="Add email address..."
              />
              <button
                onClick={handleAddRecipient}
                disabled={saving || !newRecipient}
                className="p-2 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus size={20} />
              </button>
            </div>
            <div className="space-y-2">
              {emailRecipients.map(email => (
                <div key={email} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                  <span className="text-sm text-gray-700 dark:text-gray-300">{email}</span>
                  <button
                    onClick={() => handleRemoveRecipient(email)}
                    disabled={saving}
                    className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {emailRecipients.length === 0 && (
                <p className="text-sm text-gray-500 italic">No recipients added.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
