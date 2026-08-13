'use client';

import { useCallback, useState } from 'react';
import { credentialReceipt } from '@servicebay/api-client';

/**
 * Browser half of the forced credential hand-over (#2560).
 *
 * The order of operations is the feature: **save first, confirm second.**
 * `confirm` is the call that deletes ServiceBay's copy, so it is only ever
 * reached from the success path of an actual save. Every other exit — a
 * failed request, a save the browser refused, a picker the user cancelled,
 * a file that came back short — returns without confirming, and the
 * passwords stay exactly where they were.
 *
 * See `lib/stackInstall/credentialsHandover.ts` for the server half and
 * for what the receipt does and does not prove.
 */

/** Chromium's File System Access API. Absent in Firefox/Safari and on
 *  insecure origins, hence the anchor fallback below. */
type SaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable: () => Promise<{ write: (d: BlobPart) => Promise<void>; close: () => Promise<void> }> }>;

export type HandoverOutcome =
  | { status: 'delivered'; dropped: number }
  | { status: 'nothing-pending' }
  | { status: 'failed'; message: string };

/**
 * Write the file out, throwing if the browser would not do it.
 *
 * Where the File System Access API exists we use it, because it is the
 * only browser API that *fails loudly*: the user picks a destination and a
 * cancel or a denied permission throws, so an aborted save can never be
 * mistaken for a completed one. The classic anchor download is the
 * fallback everywhere else; it is fire-and-forget by design, which is
 * precisely why the receipt round-trip below is what actually gates the
 * deletion rather than this call returning.
 */
async function saveFile(csv: string, filename: string): Promise<void> {
  const blob = new Blob([csv], { type: 'text/csv' });
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: 'Password list (CSV)', accept: { 'text/csv': ['.csv'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

const message = (e: unknown): string => {
  if (e instanceof Error) {
    // A cancelled save picker is not an error to apologise for.
    if (e.name === 'AbortError') return 'The download was cancelled, so nothing was deleted.';
    return e.message;
  }
  return String(e);
};

export async function runCredentialHandover(): Promise<HandoverOutcome> {
  let offer: { pending: number; token?: string; filename?: string; csv?: string };
  try {
    const res = await fetch('/api/system/credentials/handover', { method: 'POST' });
    offer = await res.json();
    if (!res.ok) return { status: 'failed', message: (offer as { error?: string }).error || `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'failed', message: message(e) };
  }
  if (!offer.pending || !offer.token || !offer.csv) return { status: 'nothing-pending' };

  try {
    await saveFile(offer.csv, offer.filename || 'servicebay-credentials.csv');
  } catch (e) {
    return { status: 'failed', message: message(e) };
  }

  // Only now, holding the whole file and having written it without error,
  // do we tell the server it may forget these passwords.
  try {
    const res = await fetch('/api/system/credentials/handover/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: offer.token, receipt: credentialReceipt(offer.csv) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return {
        status: 'failed',
        message: 'The saved file did not match what ServiceBay sent, so nothing was deleted. Please download it again.',
      };
    }
    return { status: 'delivered', dropped: data.dropped ?? 0 };
  } catch (e) {
    return { status: 'failed', message: message(e) };
  }
}

/** `runCredentialHandover` with the busy/error state a button needs. */
export function useCredentialHandover() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<HandoverOutcome> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await runCredentialHandover();
      if (outcome.status === 'failed') setError(outcome.message);
      return outcome;
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, error };
}
