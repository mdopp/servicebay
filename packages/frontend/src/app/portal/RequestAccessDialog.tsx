'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button, Input, Textarea } from '@/components/ui';

/**
 * The request-access modal itself — the form that collects everything
 * LLDAP needs to provision an account (first/last name, desired login,
 * email, optional note) and POSTs it to `/api/system/access-requests`
 * (public). The admin approves in Settings → Access Requests; #405 wired
 * this form to gather the profile data so approval is one click rather
 * than a round-trip to ask the requester for a username.
 *
 * Extracted from RequestAccessButton (#2405) so it can also be rendered
 * **already open** by the deep-linkable `/portal/requests` route, which
 * the Solaris companion app links straight into. The owner decides when
 * it is mounted; mounting == open, unmounting == closed (which also
 * resets the form state for free).
 */
/** Shared token-wired classes for the request-access form controls so
 *  the inputs/labels read as one consistent, design-system surface
 *  (dark-mode-correct, no raw gray-300/blue-500 literals). */
const FIELD_LABEL = 'block text-xs font-medium text-text-muted';
const FIELD_INPUT =
  'w-full px-space-3 py-space-2 text-sm rounded-card border border-border bg-surface-2 ' +
  'text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent';

export default function RequestAccessDialog({ onClose }: { onClose: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

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
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50 transition-all duration-300"
      onClick={onClose}
    >
      <div
        className="glass-panel rounded-card shadow-2xl max-w-md w-full p-space-6 max-h-[90vh] overflow-y-auto border border-border"
        onClick={e => e.stopPropagation()}
      >
        {submitted ? (
          <div className="text-center py-space-6 space-y-space-4">
            <div className="text-5xl animate-bounce">✨</div>
            <h2 className="text-2xl font-bold text-text tracking-wide">Request Sent Successfully!</h2>
            <p className="text-sm text-text-muted leading-relaxed font-medium">
              The family administrator has been notified. They will create your account in the local identity pool and notify you when it is ready.
            </p>
            <Button
              onClick={onClose}
              variant="primary"
              className="mt-space-4"
            >
              Got it
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-space-5">
            <div>
              <h2 className="text-2xl font-extrabold text-text tracking-wide">Request Access</h2>
              <p className="text-sm text-text-muted mt-1.5 font-medium leading-relaxed">
                The administrator will create your personal account. Enter your details below to get started.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-space-3">
              <div className="space-y-space-1">
                <label className={FIELD_LABEL}>
                  First name <span className="text-status-fail">*</span>
                </label>
                <Input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  required
                  maxLength={60}
                  autoComplete="given-name"
                  className={FIELD_INPUT}
                />
              </div>
              <div className="space-y-space-1">
                <label className={FIELD_LABEL}>
                  Last name <span className="text-status-fail">*</span>
                </label>
                <Input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  required
                  maxLength={60}
                  autoComplete="family-name"
                  className={FIELD_INPUT}
                />
              </div>
            </div>

            <div className="space-y-space-1">
              <label className={FIELD_LABEL}>
                Desired username <span className="text-status-fail">*</span>
              </label>
              <Input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value.toLowerCase())}
                required
                minLength={1}
                maxLength={60}
                pattern="[a-z0-9._\-]{1,60}"
                autoComplete="username"
                placeholder="e.g. max.mustermann"
                className={FIELD_INPUT}
              />
              <p className="text-[11px] text-text-subtle">
                Your login — lowercase letters, digits, dots, underscores, and hyphens only. Can&apos;t be changed later.
              </p>
            </div>

            <div className="space-y-space-1">
              <label className={FIELD_LABEL}>
                Your email <span className="text-status-fail">*</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                maxLength={200}
                autoComplete="email"
                className={FIELD_INPUT}
              />
            </div>

            <div className="space-y-space-1">
              <label className={FIELD_LABEL}>
                Anything else? <span className="text-text-subtle">(optional)</span>
              </label>
              <Textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="e.g. which services you'd like access to"
                className={FIELD_INPUT}
              />
            </div>

            {error && (
              <div className="px-space-3 py-space-2 text-xs text-status-fail bg-status-fail/10 rounded-card">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-space-2 pt-space-2">
              <Button
                type="button"
                onClick={onClose}
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                variant="primary"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Send request
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
