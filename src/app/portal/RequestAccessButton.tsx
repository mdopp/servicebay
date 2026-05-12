'use client';

import { useState } from 'react';
import { UserPlus, Loader2 } from 'lucide-react';

/**
 * "Don't have an account?" affordance on the family portal (#242
 * follow-up). Renders a small button below the card grid; clicking
 * opens a modal that collects everything LLDAP needs to provision an
 * account — first/last name, desired login, email, optional note —
 * and POSTs to /api/system/access-requests (public). The admin
 * approves in Settings → Access Requests; #405 wired this form to
 * gather the profile data so approval is one click rather than a
 * round-trip to ask the requester for a username.
 */
export default function RequestAccessButton() {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const reset = () => {
    setFirstName('');
    setLastName('');
    setUsername('');
    setEmail('');
    setMessage('');
    setError(null);
    setSubmitted(false);
  };

  const onClose = () => {
    setOpen(false);
    // Slight delay so the closing transition doesn't show the form snapping back to empty.
    setTimeout(reset, 200);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const trimmedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,60}$/.test(trimmedUsername)) {
      setError('Username may only contain lowercase letters, digits, dots, underscores, and hyphens (max 60 characters).');
      setSubmitting(false);
      return;
    }
    try {
      const res = await fetch('/api/system/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          username: trimmedUsername,
          email: email.trim(),
          message: message.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : `Submission failed (${res.status}).`);
        return;
      }
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="mt-12 text-center">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:border-blue-500 hover:text-blue-700 dark:hover:text-blue-300 text-sm font-medium text-gray-700 dark:text-gray-300 rounded-full transition-colors"
        >
          <UserPlus size={16} />
          Don&apos;t have an account yet?
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            {submitted ? (
              <div className="text-center py-8 space-y-3">
                <div className="text-5xl">✅</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Request sent</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  The family admin has been notified. They&apos;ll create your account and let you know when it&apos;s ready.
                </p>
                <button
                  onClick={onClose}
                  className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
                >
                  Got it
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">Request access</h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    The family admin will get a notification and create your account.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                      First name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={e => setFirstName(e.target.value)}
                      required
                      maxLength={60}
                      autoComplete="given-name"
                      className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                      Last name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                      required
                      maxLength={60}
                      autoComplete="family-name"
                      className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Desired username <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value.toLowerCase())}
                    required
                    minLength={1}
                    maxLength={60}
                    pattern="[a-z0-9._\-]{1,60}"
                    autoComplete="username"
                    placeholder="e.g. max.mustermann"
                    className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    Your login — lowercase letters, digits, dots, underscores, and hyphens only. Can&apos;t be changed later.
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Your email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    maxLength={200}
                    autoComplete="email"
                    className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Anything else? <span className="text-gray-400">(optional)</span>
                  </label>
                  <textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="e.g. which services you'd like access to"
                    className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 rounded">
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                  >
                    {submitting && <Loader2 size={14} className="animate-spin" />}
                    Send request
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
