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
      // #1001 — persist the request id so the portal's state-aware CTA
      // can render "Your request is being reviewed" on subsequent
      // visits without a session. The status endpoint flips this to a
      // "Set your password" link once the admin approves.
      if (typeof data.id === 'string') {
        try {
          window.localStorage.setItem(
            'sb.portal.lastAccessRequest',
            JSON.stringify({ id: data.id, submittedAt: new Date().toISOString() }),
          );
        } catch { /* quota / disabled storage — non-fatal */ }
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
          className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50 transition-all duration-300"
          onClick={onClose}
        >
          <div
            className="glass-panel rounded-2xl shadow-2xl max-w-md w-full p-8 max-h-[90vh] overflow-y-auto border border-gray-200/50 dark:border-white/10"
            onClick={e => e.stopPropagation()}
          >
            {submitted ? (
              <div className="text-center py-8 space-y-4">
                <div className="text-5xl animate-bounce">✨</div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-wide">Request Sent Successfully!</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed font-medium">
                  The family administrator has been notified. They will create your account in the local identity pool and notify you when it is ready.
                </p>
                <button
                  onClick={onClose}
                  className="mt-4 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow transition-colors"
                >
                  Got it
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-5">
                <div>
                  <h2 className="text-2xl font-extrabold text-gray-900 dark:text-white tracking-wide">Request Access</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1.5 font-medium leading-relaxed">
                    The administrator will create your personal account. Enter your details below to get started.
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
