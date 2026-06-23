'use client';

import { useState } from 'react';
import { Mail, Plus, Trash2, Send, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { useSettings } from '../SettingsContext';

// Shared token-based input chrome for this section's text fields.
const INPUT_CLASS =
  'w-full p-2 rounded-card border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none';
const LABEL_CLASS = 'block text-sm font-medium text-text-muted mb-1';

export default function EmailNotificationsSection() {
  const {
    saving,
    emailEnabled, setEmailEnabled,
    emailHost, setEmailHost,
    emailPort, setEmailPort,
    emailSecure, setEmailSecure,
    emailUser, setEmailUser,
    emailPass, setEmailPass,
    emailFrom, setEmailFrom,
    emailRecipients, setEmailRecipients,
    persistSettings,
  } = useSettings();

  const [newRecipient, setNewRecipient] = useState('');
  const [testRecipient, setTestRecipient] = useState('');
  const [testStatus, setTestStatus] = useState<{ kind: 'idle' | 'sending' | 'ok' | 'fail'; message?: string }>({ kind: 'idle' });

  const handleSendTest = async () => {
    if (!testRecipient) return;
    setTestStatus({ kind: 'sending' });
    try {
      // Flush any in-flight changes so the test uses what the operator
      // sees in the inputs — onBlur usually does this, but the click
      // path can race the blur on some browsers.
      await persistSettings();
      const res = await fetch('/api/system/notifications/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testRecipient }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.ok && data.ok) {
        setTestStatus({ kind: 'ok', message: `Sent to ${testRecipient}. Check the inbox — including spam.` });
      } else {
        const errMsg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
        setTestStatus({ kind: 'fail', message: errMsg });
      }
    } catch (e) {
      setTestStatus({ kind: 'fail', message: e instanceof Error ? e.message : String(e) });
    }
  };

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

  const handleEnabledToggle = (enabled: boolean) => {
    setEmailEnabled(enabled);
    void persistSettings({ email: { enabled } });
  };

  const handleSecureToggle = (secure: boolean) => {
    setEmailSecure(secure);
    void persistSettings({ email: { secure } });
  };

  return (
    <Card padding="none" className="w-full overflow-hidden">
      <div className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
        <div className="p-2 rounded-card bg-accent/10 text-accent">
          <Mail size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-text">Email (SMTP)</h3>
          <p className="text-xs text-text-muted">Configure SMTP settings for ServiceBay alerts</p>
        </div>
        <div className="ml-auto">
          <button
            role="switch"
            aria-checked={emailEnabled}
            aria-label="Enable email notifications"
            onClick={() => handleEnabledToggle(!emailEnabled)}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-chip transition-colors disabled:opacity-50 ${emailEnabled ? 'bg-accent' : 'bg-surface-muted border border-border'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-chip bg-white transition-transform ${emailEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>

      {emailEnabled && (
        <div className="p-space-5 space-y-6">
          <div className="rounded-card border border-status-info/30 bg-status-info/10 p-4 text-sm text-text">
            <p className="font-medium mb-1">Need help finding these settings?</p>
            <ul className="list-disc list-inside space-y-1 text-text-muted">
              <li><strong>Gmail:</strong> Host: <code>smtp.gmail.com</code>, Port: <code>587</code>. Use an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="underline text-accent hover:text-accent-strong">App Password</a> if 2FA is enabled.</li>
              <li><strong>Outlook:</strong> Host: <code>smtp.office365.com</code>, Port: <code>587</code>.</li>
              <li><strong>GMX:</strong> Host: <code>mail.gmx.net</code>, Port: <code>587</code>.</li>
            </ul>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={LABEL_CLASS}>SMTP Host</label>
              <input
                type="text"
                value={emailHost}
                onChange={e => setEmailHost(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className={INPUT_CLASS}
                placeholder="smtp.gmail.com"
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>SMTP Port</label>
              <input
                type="number"
                value={emailPort}
                onChange={e => setEmailPort(parseInt(e.target.value) || 0)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className={INPUT_CLASS}
                placeholder="587"
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>Username</label>
              <input
                type="text"
                value={emailUser}
                onChange={e => setEmailUser(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className={INPUT_CLASS}
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>Password</label>
              <input
                type="password"
                value={emailPass}
                onChange={e => setEmailPass(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className={INPUT_CLASS}
                placeholder="••••••••"
              />
            </div>
            <div className="md:col-span-2">
              <label className={LABEL_CLASS}>From Address</label>
              <input
                type="text"
                value={emailFrom}
                onChange={e => setEmailFrom(e.target.value)}
                onBlur={() => persistSettings()}
                disabled={saving}
                className={INPUT_CLASS}
                placeholder="ServiceBay <alerts@example.com>"
              />
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={emailSecure}
                  onChange={e => handleSecureToggle(e.target.checked)}
                  disabled={saving}
                  className="w-4 h-4 accent-accent rounded border-border focus:ring-2 focus:ring-accent"
                />
                <span className="text-sm text-text-muted">Use Secure Connection (TLS/SSL)</span>
              </label>
            </div>
          </div>

          <div className="border-t border-border pt-6">
            <label className="block text-sm font-medium text-text-muted mb-2">Send test email</label>
            <p className="text-xs text-text-muted mb-3">
              Verifies the SMTP settings above by sending one canned message to the address you enter. Works even when the master toggle is off — useful before enabling alerts.
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                value={testRecipient}
                onChange={e => setTestRecipient(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && testRecipient && testStatus.kind !== 'sending' && handleSendTest()}
                disabled={saving || testStatus.kind === 'sending'}
                className={`flex-1 ${INPUT_CLASS}`}
                placeholder="recipient@example.com"
              />
              <Button
                onClick={handleSendTest}
                disabled={saving || !testRecipient || testStatus.kind === 'sending'}
                className="shrink-0"
              >
                <Send size={16} />
                {testStatus.kind === 'sending' ? 'Sending…' : 'Send test'}
              </Button>
            </div>
            {testStatus.kind === 'ok' && (
              <div className="mt-3 flex items-start gap-2 p-3 rounded-card bg-status-ok/10 border border-status-ok/30 text-sm text-status-ok">
                <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                <span>{testStatus.message}</span>
              </div>
            )}
            {testStatus.kind === 'fail' && (
              <div className="mt-3 flex items-start gap-2 p-3 rounded-card bg-status-fail/10 border border-status-fail/30 text-sm text-status-fail">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium mb-0.5">SMTP rejected the test:</p>
                  <p className="font-mono text-xs break-words">{testStatus.message}</p>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-border pt-6">
            <label className="block text-sm font-medium text-text-muted mb-2">Recipients</label>
            <div className="flex gap-2 mb-3">
              <input
                type="email"
                value={newRecipient}
                onChange={e => setNewRecipient(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddRecipient()}
                disabled={saving}
                className={`flex-1 ${INPUT_CLASS}`}
                placeholder="Add email address..."
              />
              <Button
                variant="secondary"
                onClick={handleAddRecipient}
                disabled={saving || !newRecipient}
                aria-label="Add recipient"
                className="shrink-0"
              >
                <Plus size={20} />
              </Button>
            </div>
            <div className="space-y-2">
              {emailRecipients.map(email => (
                <div key={email} className="flex items-center justify-between p-2 bg-surface-2 rounded-card border border-border">
                  <span className="text-sm text-text-muted">{email}</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleRemoveRecipient(email)}
                    disabled={saving}
                    aria-label={`Remove ${email}`}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
              {emailRecipients.length === 0 && (
                <p className="text-sm text-text-subtle italic">No recipients added.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
