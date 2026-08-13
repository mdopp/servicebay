'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, Loader2 } from 'lucide-react';
import { summarizeCredentialSecurity, type Credential } from '@servicebay/api-client';
import FocusTrap from '@/components/FocusTrap';
import { Button } from '@/components/ui';
import { useCredentialHandover } from '@/hooks/useCredentialHandover';

/**
 * The forced credential hand-over (#2560).
 *
 * An install generates passwords that exist nowhere else. This gate stands
 * in front of the whole dashboard until the operator has downloaded them,
 * and ServiceBay deletes its copy the moment the download is proven — see
 * `hooks/useCredentialHandover` and `lib/stackInstall/credentialsHandover`.
 *
 * ## Why it lives in the layout rather than in the install screen
 *
 * **An install without a browser has nobody to show a window to.** The MCP
 * `install_template` tool and the REST install route run headless, and a
 * modal is inert there. Quietly deleting the copy in that case would be
 * strictly worse than today — the passwords would be gone with no one
 * having received them.
 *
 * So the rule is: *ServiceBay never deletes a password it has not proven
 * it delivered, and it never stops asking until it has.* A headless
 * install therefore keeps the copy and leaves the box in an openly pending
 * state; the hand-over then happens the first time a human opens
 * ServiceBay, because this gate is driven by "does the box still hold
 * passwords?" rather than by "did an install just finish in this tab?".
 * That single rule covers both paths, which is why there is only one
 * implementation of it.
 *
 * A browser install doesn't wait for the next page load: the install flow
 * fires `CREDENTIALS_CHANGED_EVENT` when it reaches its done phase and the
 * gate re-checks immediately.
 */

/** Fired by any surface that may have created credentials. */
export const CREDENTIALS_CHANGED_EVENT = 'servicebay:credentials-changed';

export function notifyCredentialsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT));
}

async function countPending(): Promise<number> {
  const res = await fetch('/api/system/credentials');
  if (!res.ok) return 0;
  const data = await res.json().catch(() => null);
  const creds: Credential[] = data?.manifest?.credentials ?? [];
  return summarizeCredentialSecurity(creds).unsecured;
}

function passwordCount(n: number): string {
  return n === 1 ? 'one password' : `${n} passwords`;
}

/** The wording is the deliverable as much as the blocking is: both duties
 *  (put it in Vaultwarden, show it to no one) and what losing it costs,
 *  in the words a person would use — see docs/UX_PHILOSOPHY.md. */
function HandoverDialogBody({ pending, busy, error, onDownload }: {
  pending: number;
  busy: boolean;
  error: string | null;
  onDownload: () => void;
}) {
  return (
    <div className="bg-surface rounded-card border border-border shadow-xl max-w-lg w-full p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2.5 rounded-full bg-surface-2 text-status-warn shrink-0">
          <KeyRound size={22} />
        </div>
        <div>
          <h2 id="credential-handover-title" className="text-lg font-bold text-text">
            Save your new passwords now
          </h2>
          <p className="text-sm text-text-muted mt-1">
            The install created {passwordCount(pending)}. This is the only time you get
            {pending === 1 ? ' it' : ' them'} — once the file is downloaded, ServiceBay deletes its
            own copy.
          </p>
        </div>
      </div>

      <ul className="text-sm text-text space-y-1.5 list-disc pl-5">
        <li>Put the file into Vaultwarden, your password manager.</li>
        <li>Share it with nobody.</li>
      </ul>

      <p className="text-sm text-status-warn">
        If you lose these passwords, no one can get them back — not even ServiceBay. The box would
        have to be set up again from scratch.
      </p>

      <Button onClick={onDownload} disabled={busy} variant="primary" size="md" className="w-full">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        Download the password list
      </Button>

      {error ? (
        <p className="text-sm text-status-fail" data-testid="credential-handover-error">
          {error} Nothing was deleted — you can try the download again.
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          This window stays until the download has worked. If it fails or you cancel it, nothing is
          deleted.
        </p>
      )}
    </div>
  );
}

export default function CredentialHandoverGate() {
  const [pending, setPending] = useState(0);
  const { run, busy, error } = useCredentialHandover();

  const check = useCallback(() => {
    countPending().then(setPending).catch(() => undefined);
  }, []);

  useEffect(() => {
    check();
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, check);
    return () => window.removeEventListener(CREDENTIALS_CHANGED_EVENT, check);
  }, [check]);

  if (pending === 0) return null;

  const download = async () => {
    const outcome = await run();
    // Only a proven delivery closes this. A failure leaves the gate up with
    // its reason showing — which is the honest state, because the passwords
    // are still here.
    if (outcome.status === 'delivered' || outcome.status === 'nothing-pending') setPending(0);
  };

  return (
    // Deliberately has no close button, ignores Escape and swallows clicks
    // on the backdrop. The only way past it is a download that worked.
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-handover-title"
      data-testid="credential-handover-gate"
    >
      <FocusTrap>
        <HandoverDialogBody pending={pending} busy={busy} error={error} onDownload={download} />
      </FocusTrap>
    </div>
  );
}
